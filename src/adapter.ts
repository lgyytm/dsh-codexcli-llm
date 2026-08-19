/**
 * Local Codex CLI LLM adapter with session-scoped connections. The adapter
 * still registers the fixed `codex` provider route on `ctx.llm` (so the GUI's
 * model picker and settings page keep working), but each DSH session reuses
 * one persistent Codex thread across turns, and every Codex item lifecycle —
 * agent messages, reasoning, tool actions, approval requests, token usage —
 * is reported through injectable callbacks so the harness can observe,
 * approve, and meter the child's agent loop.
 *
 * @module dsh-codex/adapter
 */

import { Buffer } from 'node:buffer'
import { basename } from 'node:path'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {
  CodexApprovalHandler,
  CodexApprovalDecision,
  CodexApprovalPolicy,
  CodexApprovalRequest,
  CodexChildSpec,
  CodexGeneratedImage,
  CodexItemEvent,
  CodexReasoningSummary,
} from './app-server/index.ts'
import {
  listCodexModels,
  startCodexSession,
  runCodexSessionTurn,
  type CodexSessionConnection,
} from './run.ts'

/** The single provider route this adapter owns. */
export const PROVIDER = 'codex'

/** Advisory context capacity for the local Codex model, in tokens. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

const DEFAULT_MODEL: LlmModelInfo = {
  provider: PROVIDER,
  id: PROVIDER,
  name: 'Codex default',
  description: 'Use the model selected by the local Codex configuration',
  inputModalities: ['text'],
}

/** Observation callbacks the harness injects to see a session's Codex turn. */
export interface CodexObservationSinks {
  /** Called for every normalized Codex item lifecycle event during a turn. */
  readonly onItem?: (sessionId: string, item: CodexItemEvent) => void
  /** Called once per turn with the child's reported token usage. */
  readonly onTokenUsage?: (sessionId: string, usage: TokenUsage) => void
}

/** Adapter construction inputs; resolved per request through a thunk. */
export interface CodexLlmAdapterOptions {
  /** Session workspace supplied to `thread/start`. */
  readonly cwd: string
  /** Explicit child environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace. */
  readonly disposeGraceMs: number
  /** Unattended answer to Codex approval requests. */
  readonly approval: CodexApprovalPolicy
  /** Reasoning-summary policy sent to every Codex turn. */
  readonly reasoningSummary: CodexReasoningSummary
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Durable image store used for completed Codex image-generation results. */
  readonly attachments: AttachmentStore
  /** Observation sinks; absent keeps the adapter a plain text bridge. */
  readonly sinks?: CodexObservationSinks
  /** Approval handler; absent falls back to the policy. */
  readonly resolveApproval?: (
    sessionId: string,
    request: CodexApprovalRequest,
  ) => Promise<CodexApprovalDecision> | CodexApprovalDecision
  /** Session teardown hook; the plugin drains connections here. */
  readonly onSessionEnd?: (sessionId: string, connection: CodexSessionConnection) => void
}

interface SyncedMessage {
  readonly id?: string
  readonly role: Message['role']
  readonly content: string
}

interface CodexSessionState {
  readonly connection: CodexSessionConnection
  readonly model: string
  synced: readonly SyncedMessage[]
}

function childSpec(adapter: CodexLlmAdapterOptions): CodexChildSpec {
  return {
    cwd: adapter.cwd,
    env: adapter.env,
    disposeGraceMs: adapter.disposeGraceMs,
    approval: adapter.approval,
    spawn: adapter.spawn,
  }
}

function explicitModel(model: string): string | undefined {
  return model === PROVIDER ? undefined : model
}

function contentKey(message: Pick<Message, 'role' | 'content'>): string {
  return JSON.stringify([message.role, message.content])
}

function observedMessage(message: Message): SyncedMessage {
  return { id: String(message.id), role: message.role, content: contentKey(message) }
}

function generatedAnswer(content: ContentBlock[]): SyncedMessage {
  const message = { role: 'assistant' as const, content }
  return { role: message.role, content: contentKey(message) }
}

async function materializeGeneratedImages(
  images: readonly CodexGeneratedImage[] | undefined,
  attachments: AttachmentStore,
): Promise<ContentBlock[]> {
  if (images === undefined) return []
  return Promise.all(images.map(async (image) => {
    const data = Buffer.from(image.base64, 'base64')
    const name = image.savedPath === undefined ? undefined : basename(image.savedPath)
    const attachment = await attachments.saveImage({
      data,
      mediaType: 'image/png',
      ...name === undefined || name.length === 0 ? {} : { name },
    })
    return { type: 'image' as const, attachment }
  }))
}

function matches(expected: SyncedMessage, actual: Message): boolean {
  return expected.id === undefined
    ? expected.role === actual.role && expected.content === contentKey(actual)
    : expected.id === String(actual.id)
}

function synchronizedPrefixLength(
  synced: readonly SyncedMessage[],
  messages: readonly Message[],
): number | undefined {
  if (synced.length > messages.length) return undefined
  for (const [index, expected] of synced.entries()) {
    if (!matches(expected, messages[index] as Message)) return undefined
  }
  return synced.length
}

/**
 * Translate one assembled model request into the standalone Codex task text.
 * Callers choose the unsynchronized message suffix. A new Codex thread gets
 * the complete DSH history; a synchronized persistent thread gets only the
 * messages added since its previous successful turn.
 * @param options - the fully-assembled request.
 * @param messages - history slice to include (default: the complete request).
 * @returns the Codex turn input text.
 */
export function translateRequest(
  options: GenerateOptions,
  messages: readonly Message[] = options.messages,
): string {
  const sections: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(`System instructions:\n${options.system}`)
  }
  for (const message of messages) {
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.length === 0) continue
    switch (message.role) {
      case 'user':
        sections.push(`User:\n${text}`)
        break
      case 'assistant':
        sections.push(`Assistant:\n${text}`)
        break
      case 'system':
        sections.push(`System:\n${text}`)
        break
    }
  }
  if (sections.length === 0) {
    throw new Error('llm-codex: cannot translate an empty model request')
  }
  return sections.join('\n\n')
}

/** The local Codex adapter: one provider route, one advisory model. */
export class CodexLlmAdapter extends LlmAdapter {
  private readonly connections = new Map<string, CodexSessionState>()
  private readonly catalogAbort = new AbortController()
  private modelCatalog: Promise<readonly LlmModelInfo[]> | undefined

  constructor(private readonly options: () => CodexLlmAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Codex (local CLI)' }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.modelCatalog !== undefined) return this.modelCatalog
    const pending = listCodexModels(
      childSpec(this.options()),
      this.catalogAbort.signal,
    ).then(
      models => [
        ...models.map(model => ({
          provider: PROVIDER,
          id: model.id,
          name: model.name,
          description: model.description,
          inputModalities: ['text' as const],
        })),
        DEFAULT_MODEL,
      ],
      () => {
        this.modelCatalog = undefined
        return [DEFAULT_MODEL]
      },
    )
    this.modelCatalog = pending
    return pending
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model === PROVIDER ? 'Codex default' : model,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal ?? new AbortController().signal
    const adapter = this.options()
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)

    return this.streamTurn(childSpec(adapter), adapter, sessionId, options, signal)
  }

  private async *streamTurn(
    spec: CodexChildSpec,
    adapter: CodexLlmAdapterOptions,
    sessionId: string,
    request: GenerateOptions,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    let state = this.connections.get(sessionId)
    if (state !== undefined && state.model !== request.model) {
      this.connections.delete(sessionId)
      await state.connection.dispose()
      state = undefined
    }
    let prefix = state === undefined
      ? 0
      : synchronizedPrefixLength(state.synced, request.messages)
    if (state !== undefined && prefix === undefined) {
      this.connections.delete(sessionId)
      await state.connection.dispose()
      state = undefined
      prefix = 0
    }
    if (state === undefined || state.connection.threadId === undefined) {
      const onItemSink = adapter.sinks?.onItem
      const onItem = onItemSink === undefined
        ? undefined
        : (item: CodexItemEvent): void => { onItemSink(sessionId, item) }
      const resolveApproval: CodexApprovalHandler | undefined = adapter.resolveApproval === undefined
        ? undefined
        : request => adapter.resolveApproval?.(sessionId, request) as Promise<CodexApprovalDecision> | CodexApprovalDecision
      const connection = await startCodexSession(
        spec,
        signal,
        explicitModel(request.model),
        onItem,
        resolveApproval,
      )
      state = { connection, model: request.model, synced: [] }
      this.connections.set(sessionId, state)
      prefix = 0
    }
    const text = translateRequest(request, request.messages.slice(prefix))
    try {
      const completed = await runCodexSessionTurn(
        state.connection,
        text,
        signal,
        adapter.reasoningSummary,
        explicitModel(request.model),
      )
      /* v8 ignore next 5 -- abort races the turn completion; runCodexSessionTurn rejects on abort */
      if (signal.aborted) {
        throw new LlmError('llm-codex: request aborted', 'ABORTED')
      }
      let imageBlocks: ContentBlock[]
      try {
        imageBlocks = await materializeGeneratedImages(
          completed.generatedImages,
          adapter.attachments,
        )
      } catch (error: unknown) {
        this.connections.delete(sessionId)
        try {
          await state.connection.dispose()
        } catch {
          // The attachment failure remains authoritative after best-effort child cleanup.
        }
        throw error
      }
      const content = [...imageBlocks, ...completed.output]
      state.synced = [
        ...request.messages.map(observedMessage),
        generatedAnswer(content),
      ]
      if (completed.usage !== undefined) {
        adapter.sinks?.onTokenUsage?.(sessionId, completed.usage)
      }
      for (const [index, block] of content.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
        yield { type: 'block-end', index, block }
      }
      if (completed.usage !== undefined) yield { type: 'usage', usage: completed.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error: unknown) {
      if (signal.aborted) {
        if (this.connections.get(sessionId) === state) {
          this.connections.delete(sessionId)
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              /* v8 ignore next -- runCodexSessionTurn rejects with Error */
              message: error instanceof Error ? error.message : String(error),
              code: 'ABORTED',
            },
          },
        }
        return
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            /* v8 ignore next -- typed subprocess/wire failures reject with Error */
            message: error instanceof Error ? error.message : String(error),
            /* v8 ignore next -- only the LlmError path is exercised */
            code: error instanceof LlmError ? error.code : 'PROVIDER_ERROR',
          },
        },
      }
    }
  }

  /**
   * Dispose one session's connection. Called by the plugin on session end.
   * @param sessionId - the session whose connection to release.
   */
  disposeSession(sessionId: string): Promise<void> {
    const state = this.connections.get(sessionId)
    if (state === undefined) return Promise.resolve()
    this.connections.delete(sessionId)
    return state.connection.dispose()
  }

  /**
   * Dispose every live connection. Called by the plugin on unload.
   */
  disposeAll(): Promise<void[]> {
    this.catalogAbort.abort(new Error('llm-codex: adapter disposed'))
    const catalog = this.modelCatalog?.then(() => undefined)
    const states = [...this.connections.values()]
    this.connections.clear()
    return Promise.all([
      ...states.map(state => state.connection.dispose()),
      ...catalog === undefined ? [] : [catalog],
    ])
  }
}
