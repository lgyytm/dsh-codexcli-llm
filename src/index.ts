/**
 * Local Codex CLI LLM adapter plugin. Registers the fixed `codex` provider
 * route on `ctx.llm` so the GUI's model picker and settings page can select
 * it. Under the hood each DSH session reuses one persistent Codex thread, and
 * every Codex item and delta — agent messages, reasoning, tool actions,
 * approval requests — is appended to the session log as a plugin-owned event
 * (`codex/turn-item`), so the harness observes the child's agent loop instead
 * of treating it as a black box.
 *
 * ```yaml
 * - id: llm-codex
 *   name: 'dsh-codex'
 *   config:
 *     cwd: !!js process.env.DSH_CWD ?? process.cwd()
 *     approval: ask
 *     env:
 *       OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
 * ```
 *
 * @module dsh-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodexLlmAdapter, PROVIDER } from './adapter.ts'
import type { CodexLlmAdapterOptions } from './adapter.ts'
import type {} from './types.ts'
import type {
  CodexApprovalPolicy,
  CodexApprovalRequest,
  CodexReasoningSummary,
} from './app-server/index.ts'
import { DEFAULT_DISPOSE_GRACE_MS } from './app-server/index.ts'

export { CodexLlmAdapter, PROVIDER } from './adapter.ts'
export type { CodexLlmAdapterOptions, CodexObservationSinks } from './adapter.ts'
export { translateRequest } from './adapter.ts'
export type { CodexApprovalPolicy, CodexReasoningSummary } from './app-server/index.ts'
export type { CodexChildSpec, CodexSessionConnection } from './run.ts'
export type { CodexObservationStage, CodexTurnItemData } from './types.ts'

function approvalToolName(request: CodexApprovalRequest): string {
  switch (request.method) {
    case 'item/commandExecution/requestApproval': return 'codex.commandExecution'
    case 'item/fileChange/requestApproval': return 'codex.fileChange'
    case 'item/permissions/requestApproval': return 'codex.permissions'
  }
}

function approvalReason(request: CodexApprovalRequest): string | undefined {
  if (typeof request.params.reason === 'string') return request.params.reason
  if (typeof request.params.command === 'string') return request.params.command
  return undefined
}

async function requestApproval(
  ctx: Context,
  sessionId: string,
  request: CodexApprovalRequest,
): Promise<'allow' | 'decline' | 'cancel'> {
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent === undefined) return 'decline'
  const itemId = typeof request.params.itemId === 'string'
    ? CallId(request.params.itemId)
    : undefined
  const reason = approvalReason(request)
  const outcome = await ctx.approval.request({
    agent,
    toolName: approvalToolName(request),
    ...itemId === undefined ? {} : { callId: itemId },
    ...reason === undefined ? {} : { reason },
    signal: request.signal,
  })
  if (outcome === 'allowed-once') return 'allow'
  if (outcome === 'cancelled') return 'cancel'
  return 'decline'
}

export const name = 'llm-codex'
export const inject = ['llm', 'subprocess', 'sessions', 'agents', 'approval', 'attachments']

const NS = settingsNamespace('llm-codex')

/**
 * Plugin config, doubling as the `llm-codex` settings-section shape. Every
 * field is optional in yml.
 */
export interface Config {
  /** Session workspace supplied to `thread/start`; default `process.cwd()`. */
  cwd?: string
  /** Approval behavior: ask through DSH, or answer unattended (default `ask`). */
  approval?: CodexApprovalPolicy
  /** Reasoning-summary detail requested from Codex (default `detailed`). */
  reasoningSummary?: CodexReasoningSummary
  /** Explicit child environment layered over the subprocess seam's scrub. */
  env?: Record<string, string>
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  approval: z.union(['ask', 'allow', 'decline', 'cancel']).default('ask'),
  reasoningSummary: z.union(['auto', 'concise', 'detailed', 'none']).default('detailed'),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Config>

/** The configurable-provider directory: the one fixed route, always offered. */
function directoryEntry(): LlmConfigurableProvider[] {
  return [{
    provider: PROVIDER,
    displayName: 'Codex (local CLI)',
    settingsNs: NS,
    settingsPath: [],
  }]
}

/**
 * Register the fixed `codex` provider route.
 * @param ctx - context exposing the LLM and subprocess services.
 * @param config - composition entry config, the base of the settings section.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  const resolved = (): ResolvedConfig => current() as ResolvedConfig
  if (resolved().disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }

  const adapterOptions = (): CodexLlmAdapterOptions => {
    const value = resolved()
    return {
      cwd: value.cwd,
      env: value.env,
      disposeGraceMs: value.disposeGraceMs,
      approval: value.approval,
      reasoningSummary: value.reasoningSummary,
      spawn: spec => ctx.subprocess.spawn(spec),
      attachments: ctx.attachments,
      sinks: {
        onItem: (sessionId, item) => {
          const session = ctx.sessions.get(sessionId as SessionId)
          if (session === undefined) return
          session.append('codex/turn-item', {
            threadId: item.threadId,
            turnId: item.turnId,
            stage: item.stage,
            type: item.type,
            ...item.itemId === undefined ? {} : { itemId: item.itemId },
            ...item.timeMs === undefined ? {} : { timeMs: item.timeMs },
            ...item.text === undefined ? {} : { text: item.text },
            ...item.phase === undefined ? {} : { phase: item.phase },
            ...item.reasoning === undefined ? {} : { reasoning: item.reasoning },
            ...item.reasoningKind === undefined ? {} : { reasoningKind: item.reasoningKind },
            ...item.toolName === undefined ? {} : { toolName: item.toolName },
            ...item.toolArguments === undefined ? {} : { toolArguments: item.toolArguments },
            ...item.toolResult === undefined ? {} : { toolResult: item.toolResult },
            ...item.status === undefined ? {} : { status: item.status },
            ...item.error === undefined ? {} : { error: item.error },
            ...item.durationMs === undefined ? {} : { durationMs: item.durationMs },
            ...item.exitCode === undefined ? {} : { exitCode: item.exitCode },
            ...item.approvalMethod === undefined ? {} : { approvalMethod: item.approvalMethod },
            ...item.approvalDecision === undefined ? {} : { approvalDecision: item.approvalDecision },
            ...item.usage === undefined ? {} : { usage: item.usage },
          })
        },
        onTokenUsage: (sessionId, usage) => {
          ctx.sessions.get(sessionId as SessionId)?.append('codex/token-usage', usage)
        },
      },
      ...value.approval === 'ask'
        ? { resolveApproval: (sessionId, request) => requestApproval(ctx, sessionId, request) }
        : {},
    }
  }
  const adapter = new CodexLlmAdapter(adapterOptions)
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Release a session's persistent Codex connection when the session ends.
  /* v8 ignore start -- teardown failure paths: logged, never thrown into the event */
  ctx.on('session/disposed', (session) => {
    void adapter.disposeSession(String(session.id)).catch((error: unknown) => {
      ctx.logger.warn(`llm-codex: session teardown failed: ${String(error)}`)
    })
  })
  // Release every live connection when the plugin unloads.
  ctx.effect(() => () => {
    void adapter.disposeAll().catch((error: unknown) => {
      ctx.logger.warn(`llm-codex: unload teardown failed: ${String(error)}`)
    })
  })
  /* v8 ignore end */

  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntry()
    /* v8 ignore next -- the one fixed entry never changes, so the equality short-circuit is unreachable in practice */
    if (deepEqualJson(entries, directoryFacts)) return
    /* v8 ignore next 4 -- the directory is registered once and never replaced: the entry set is constant */
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()

  /* v8 ignore start -- standard settings wiring with a constant directory */
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      ensureDirectory()
    },
  })
  /* v8 ignore end */
}
