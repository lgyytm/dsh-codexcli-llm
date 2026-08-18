/**
 * Minimal Codex app-server protocol adapter shared by the subagent and LLM
 * seams. The shared JSON-RPC transport owns framing and request correlation;
 * this module owns only the product methods, current thread/turn association,
 * configurable approval responses, item event reporting, and terminal-answer
 * selection.
 *
 * @module dsh-codex/app-server/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

/** Unattended answer to a Codex approval request. */
export type CodexApprovalPolicy = 'ask' | 'allow' | 'decline' | 'cancel'

/** Harness-side closed approval vocabulary, before product response mapping. */
export type CodexApprovalDecision = 'allow' | 'decline' | 'cancel'

/** App-server reasoning-summary policy applied to a Codex turn. */
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'

/** Picker-visible Codex model returned by the app-server catalog. */
export interface CodexModelInfo {
  /** Exact model value accepted by `thread/start` and `turn/start`. */
  readonly id: string
  /** Product-owned display label. */
  readonly name: string
  /** Product-owned model description. */
  readonly description: string
  /** Whether Codex recommends this model as its default. */
  readonly isDefault: boolean
}

/** The terminal result of one Codex turn, neutral across seams. */
export interface CodexTurnResult {
  /** The selected final or nullable-phase answer, if any. */
  readonly output: ContentBlock[]
  /** Why the turn ended. `max-tokens` means `output` may be partial. */
  readonly stopReason: 'completed' | 'max-tokens'
  /** Per-turn usage reported by the app-server, when available. */
  readonly usage?: TokenUsage
  /** Generated raster images reported by completed image-generation items. */
  readonly generatedImages?: readonly CodexGeneratedImage[]
}

/** Provider bytes and display metadata for one completed Codex image generation. */
export interface CodexGeneratedImage {
  /** Base64-encoded PNG bytes returned by the app-server. */
  readonly base64: string
  /** Prompt revised by the image model, when reported. */
  readonly revisedPrompt?: string
  /** Display name derived later from the product-owned saved path. */
  readonly savedPath?: string
  /** Whether the product requested a transparent background. */
  readonly transparentBackground?: boolean
}

/** Lifecycle point reported for one normalized Codex observation. */
export type CodexItemStage =
  | 'item-started'
  | 'item-delta'
  | 'item-completed'
  | 'approval-requested'
  | 'approval-decided'
  | 'token-usage'

/** Product item fields normalized independently from notification framing. */
export interface CodexItemDetails {
  /** The product item `type` tag. */
  readonly type: string
  /** Agent-message text, when the item is an agent message. */
  readonly text?: string
  /** Agent-message phase (`final_answer`, `commentary`, or null). */
  readonly phase?: string | null
  /** Reasoning summary text, when the item is reasoning. */
  readonly reasoning?: string
  /** Whether the displayed reasoning text is a product summary or content delta. */
  readonly reasoningKind?: 'summary' | 'content'
  /** Tool name, when the item is a tool action. */
  readonly toolName?: string
  /** Tool arguments, when the item is a tool action. */
  readonly toolArguments?: unknown
  /** Tool output or structured result, when available. */
  readonly toolResult?: unknown
  /** Product lifecycle status, when the item declares one. */
  readonly status?: string
  /** Product error text, when available. */
  readonly error?: string
  /** Tool duration in milliseconds, when available. */
  readonly durationMs?: number
  /** Process exit code, when available. */
  readonly exitCode?: number
  /** Product approval method, for request/decision observation events. */
  readonly approvalMethod?: CodexApprovalRequest['method']
  /** Closed harness decision, for approval-decision observation events. */
  readonly approvalDecision?: CodexApprovalDecision
  /** Per-turn usage, for token-usage observation events. */
  readonly usage?: TokenUsage
  /** Generated image bytes retained in memory until the owning adapter persists them. */
  readonly generatedImage?: CodexGeneratedImage
  /** The raw product item object. */
  readonly raw: JsonObject
}

/**
 * One Codex lifecycle observation with stable thread, turn, and item identity.
 * Every callback value can be persisted and replayed without consulting live
 * wire state; item-less token updates omit `itemId`.
 */
export interface CodexItemEvent extends CodexItemDetails {
  /** App-server thread containing the observation. */
  readonly threadId: string
  /** App-server turn containing the observation. */
  readonly turnId: string
  /** Stable product item id, when the observation belongs to one item. */
  readonly itemId?: string
  /** Lifecycle point represented by this observation. */
  readonly stage: CodexItemStage
  /** Product timestamp for this lifecycle point, when supplied. */
  readonly timeMs?: number
}

/** A Codex approval request the harness must answer. */
export interface CodexApprovalRequest {
  readonly method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/permissions/requestApproval'
  readonly threadId: string
  readonly turnId: string
  /** The raw request params. */
  readonly params: JsonObject
  /** The active DSH turn cancellation signal. */
  readonly signal: AbortSignal
}

/** A handler answering one approval request in the harness decision vocabulary. */
export type CodexApprovalHandler = (
  request: CodexApprovalRequest,
) => Promise<CodexApprovalDecision> | CodexApprovalDecision

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`dsh-codex-app-server: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-codex-app-server: app-server returned invalid ${label}`)
  }
  return value
}

function approvalDecision(
  policy: CodexApprovalPolicy,
  params: JsonObject,
): CodexApprovalDecision {
  if (policy === 'allow') return 'allow'
  /* v8 ignore next -- `ask` always installs a resolver; this is its fail-closed guard. */
  if (policy === 'ask') return 'decline'
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes(policy)) return policy
    if (available.includes('decline')) return 'decline'
  }
  throw new Error('dsh-codex-app-server: app-server offered no usable unattended approval decision')
}

function approvalResponse(
  method: CodexApprovalRequest['method'],
  decision: CodexApprovalDecision,
  params: JsonObject,
): JsonObject {
  if (method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval') {
    return { decision: decision === 'allow' ? 'accept' : decision }
  }
  return decision === 'allow'
    ? { permissions: object(params.permissions, 'permissions request permissions'), scope: 'turn' }
    : { permissions: {}, scope: 'turn' }
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`dsh-codex-app-server: app-server returned invalid ${label}`)
  }
  return value as number
}

/** Map one app-server usage breakdown to disjoint Harness token buckets. */
export function normalizeTokenUsage(value: unknown): TokenUsage {
  const usage = object(value, 'token usage')
  const input = nonnegativeInteger(usage.inputTokens, 'token usage inputTokens')
  const output = nonnegativeInteger(usage.outputTokens, 'token usage outputTokens')
  const cacheRead = nonnegativeInteger(usage.cachedInputTokens, 'token usage cachedInputTokens')
  const cacheWrite = usage.cacheWriteInputTokens === undefined
    ? 0
    : nonnegativeInteger(usage.cacheWriteInputTokens, 'token usage cacheWriteInputTokens')
  const reasoning = nonnegativeInteger(usage.reasoningOutputTokens, 'token usage reasoningOutputTokens')
  return {
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: output,
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    ...reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * Normalize a completed Codex item into the observation shape the harness
 * consumes: agent messages carry text and phase, reasoning carries its
 * summary, and tool actions carry name and arguments.
 * @param item - the raw product item object.
 * @returns the normalized event, or null for item types the harness ignores.
 */
export function normalizeItem(item: JsonObject): CodexItemDetails | null {
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'agentMessage' || type === 'agent_message' || type === 'message') {
    // The real app-server emits `agentMessage` with a plain `text` field; the
    // Responses-style `message` shape carries `content` blocks instead. A
    // malformed agent message fails closed rather than silently dropping it.
    const text = typeof item.text === 'string'
      ? item.text
      : Array.isArray(item.content)
        ? item.content
          .filter(part => part !== null && typeof part === 'object')
          .map(part => (part as JsonObject).text)
          .filter((part): part is string => typeof part === 'string')
          .join('')
        : (() => { throw new Error('dsh-codex-app-server: app-server returned an invalid agent message') })()
    const phase = item.phase === null || item.phase === undefined ? null
      : typeof item.phase === 'string' ? item.phase
        : (() => { throw new Error('dsh-codex-app-server: app-server returned an invalid agent message phase') })()
    return {
      type: 'agent_message',
      text,
      phase,
      raw: item,
    }
  }
  if (type === 'reasoning') {
    const summary = typeof item.summary === 'string'
      ? item.summary
      : Array.isArray(item.summary)
        ? item.summary
          .map(part => typeof part === 'string'
            ? part
            : part !== null && typeof part === 'object'
              ? (part as JsonObject).text
              : undefined)
          .filter((part): part is string => typeof part === 'string')
          .join('')
        : typeof item.text === 'string' ? item.text : ''
    return {
      type: 'reasoning',
      reasoning: summary,
      reasoningKind: item.summary === undefined ? 'content' : 'summary',
      raw: item,
    }
  }
  if (type === 'imageGeneration') {
    const status = typeof item.status === 'string' ? item.status : ''
    const result = typeof item.result === 'string' ? item.result : ''
    if (status === 'completed' && result.length === 0) {
      throw new Error('dsh-codex-app-server: completed image generation omitted its result')
    }
    const revisedPrompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : undefined
    const savedPath = typeof item.savedPath === 'string' ? item.savedPath : undefined
    const transparentBackground = typeof item.transparentBackground === 'boolean'
      ? item.transparentBackground
      : undefined
    return {
      type,
      toolName: 'imageGeneration',
      toolArguments: {
        ...revisedPrompt === undefined ? {} : { revisedPrompt },
        ...transparentBackground === undefined ? {} : { transparentBackground },
      },
      ...status.length === 0 ? {} : { status },
      ...result.length === 0
        ? {}
        : {
          toolResult: { generated: true },
          generatedImage: {
            base64: result,
            ...revisedPrompt === undefined ? {} : { revisedPrompt },
            ...savedPath === undefined ? {} : { savedPath },
            ...transparentBackground === undefined ? {} : { transparentBackground },
          },
        },
      raw: item,
    }
  }
  if (type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : ''
    const cwd = typeof item.cwd === 'string' ? item.cwd : undefined
    const output = item.aggregatedOutput ?? item.output ?? item.result
    return {
      type,
      toolName: 'commandExecution',
      toolArguments: { command, ...cwd === undefined ? {} : { cwd } },
      ...output === undefined || output === null ? {} : { toolResult: output },
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {},
      ...typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {},
      raw: item,
    }
  }
  if (type === 'fileChange') {
    const result = item.result ?? item.output ?? item.patch
    return {
      type,
      toolName: 'fileChange',
      toolArguments: { changes: Array.isArray(item.changes) ? item.changes : [] },
      ...result === undefined || result === null ? {} : { toolResult: result },
      ...typeof item.status === 'string' ? { status: item.status } : {},
      raw: item,
    }
  }
  if (type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : 'mcp'
    const tool = typeof item.tool === 'string' ? item.tool : 'tool'
    const error = item.error !== null && typeof item.error === 'object' && !Array.isArray(item.error)
      && typeof (item.error as JsonObject).message === 'string'
      ? (item.error as JsonObject).message as string
      : undefined
    return {
      type,
      toolName: `${server}.${tool}`,
      toolArguments: item.arguments,
      ...item.result === null || item.result === undefined ? {} : { toolResult: item.result },
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...error === undefined ? {} : { error },
      ...typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {},
      raw: item,
    }
  }
  if (type === 'dynamicToolCall') {
    const namespace = typeof item.namespace === 'string' && item.namespace.length > 0
      ? `${item.namespace}.`
      : ''
    const tool = typeof item.tool === 'string' ? item.tool : 'tool'
    return {
      type,
      toolName: `${namespace}${tool}`,
      toolArguments: item.arguments,
      ...item.contentItems === null || item.contentItems === undefined
        ? {}
        : { toolResult: item.contentItems },
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...item.success === false ? { error: 'Dynamic tool call failed' } : {},
      ...typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {},
      raw: item,
    }
  }
  if (type === 'webSearch') {
    return {
      type,
      toolName: 'webSearch',
      toolArguments: {
        query: typeof item.query === 'string' ? item.query : '',
        ...item.action === null || item.action === undefined ? {} : { action: item.action },
      },
      ...item.results === null || item.results === undefined ? {} : { toolResult: item.results },
      raw: item,
    }
  }
  if (type === 'collabAgentToolCall') {
    return {
      type,
      toolName: typeof item.tool === 'string' ? `agent.${item.tool}` : 'agent',
      toolArguments: {
        ...typeof item.prompt === 'string' ? { prompt: item.prompt } : {},
        ...typeof item.model === 'string' ? { model: item.model } : {},
        ...Array.isArray(item.receiverThreadIds) ? { receiverThreadIds: item.receiverThreadIds } : {},
      },
      ...typeof item.status === 'string' ? { status: item.status } : {},
      raw: item,
    }
  }
  if (type === 'local_shell_call' || type === 'function_call' || type === 'web_search_call') {
    const result = item.output ?? item.result ?? item.content
    const error = typeof item.error === 'string'
      ? item.error
      : item.error !== null && typeof item.error === 'object' && !Array.isArray(item.error)
        && typeof (item.error as JsonObject).message === 'string'
        ? (item.error as JsonObject).message as string
        : undefined
    return {
      type,
      toolName: typeof item.name === 'string' ? item.name : type,
      toolArguments: item.arguments ?? item.action,
      ...result === undefined || result === null ? {} : { toolResult: result },
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...error === undefined ? {} : { error },
      ...typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {},
      ...typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {},
      raw: item,
    }
  }
  return { type: 'other', raw: item }
}

function isContextWindowExceeded(turn: JsonObject): boolean {
  if (turn.status !== 'failed') return false
  const error = turn.error
  return error !== null
    && typeof error === 'object'
    && !Array.isArray(error)
    && (error as JsonObject).codexErrorInfo === 'contextWindowExceeded'
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`dsh-codex-app-server: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One app-server connection and a thread/turn. Supports both the one-shot
 * ephemeral-thread contract and a persistent thread reused across turns.
 *
 * The class deliberately exposes no generic request surface. Supporting
 * another product method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private turnId: string | undefined
  private pendingTurnId: string | undefined
  /** The last turn id committed on this connection; stale-frame discriminator. */
  private lastCommittedTurnId: string | undefined
  private turnCompleted: PromiseWithResolvers<JsonObject> | undefined
  private readonly earlyTurnNotifications: Array<{
    readonly method: string
    readonly params: JsonObject
  }> = []
  private lastFinalAnswer: string | undefined
  private lastUnphasedAnswer: string | undefined
  private lastUsage: TokenUsage | undefined
  private generatedImages: CodexGeneratedImage[] = []
  private turnSignal: AbortSignal | undefined
  private closed = false

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly approval: CodexApprovalPolicy,
    private readonly onItem?: (item: CodexItemEvent) => void,
    private readonly resolveApproval?: CodexApprovalHandler,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of their per-run streams so no late
    // EPIPE or read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the required app-server initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Create a thread and retain its identity.
   * @param cwd - parent workspace.
   * @param signal - unpublished-start cancellation.
   * @param ephemeral - whether the thread is ephemeral (default true).
   * @param model - explicit model override; absent uses Codex configuration.
   */
  async startThread(
    cwd: string,
    signal: AbortSignal,
    ephemeral = true,
    model?: string,
  ): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral,
      ...model === undefined ? {} : { model },
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (thread.ephemeral !== ephemeral) {
      throw new Error('dsh-codex-app-server: app-server did not create the requested thread kind')
    }
    this.threadId = id
  }

  /**
   * List every picker-visible model advertised by this app-server process.
   * @param signal - cancellation for all catalog pages.
   * @returns the product catalog in server order.
   */
  async listModels(signal: AbortSignal): Promise<readonly CodexModelInfo[]> {
    const models: CodexModelInfo[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = object(await this.guarded(this.transport.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...cursor === undefined ? {} : { cursor },
      }, signal), signal), 'model/list response')
      if (!Array.isArray(response.data)) {
        throw new Error('dsh-codex-app-server: app-server returned invalid model/list data')
      }
      for (const value of response.data) {
        const model = object(value, 'model/list model')
        if (typeof model.description !== 'string' || typeof model.isDefault !== 'boolean') {
          throw new Error('dsh-codex-app-server: app-server returned invalid model/list model metadata')
        }
        models.push({
          id: string(model.model, 'model/list model id'),
          name: string(model.displayName, 'model/list model displayName'),
          description: model.description,
          isDefault: model.isDefault,
        })
      }
      if (response.nextCursor === null || response.nextCursor === undefined) return models
      cursor = string(response.nextCursor, 'model/list nextCursor')
      if (cursors.has(cursor)) {
        throw new Error('dsh-codex-app-server: app-server repeated a model/list cursor')
      }
      cursors.add(cursor)
    } while (true)
  }

  /**
   * The current thread id, once started.
   * @returns the thread id, or undefined before `startThread`.
   */
  thread(): string | undefined {
    return this.threadId
  }

  /**
   * Submit the one text task and wait for this thread/turn's authoritative
   * terminal notification.
   * @param texts - the task text blocks.
   * @param signal - local cancellation for the published run.
   * @param summary - optional reasoning-summary override for this turn.
   * @param model - explicit model override for this and subsequent turns.
   * @returns the selected final answer, or the partial answer on max-tokens.
   */
  async runTurn(
    texts: readonly string[],
    signal: AbortSignal,
    summary?: CodexReasoningSummary,
    model?: string,
  ): Promise<CodexTurnResult> {
    const completion = Promise.withResolvers<JsonObject>()
    this.turnCompleted = completion
    // A persistent thread runs multiple turns. Each turn starts a fresh
    // identity window; early notifications (which can precede the turn/start
    // response on a persistent thread) buffer until the id is committed, and
    // a frame that does not match the committed turn is dropped.
    this.turnId = undefined
    this.pendingTurnId = undefined
    this.lastFinalAnswer = undefined
    this.lastUnphasedAnswer = undefined
    this.lastUsage = undefined
    this.generatedImages = []
    this.turnSignal = signal
    const threadId = this.threadId as string
    const response = object(await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
      ...summary === undefined ? {} : { summary },
      ...model === undefined ? {} : { model },
    }, signal), signal), 'turn/start response')
    const turn = object(response.turn, 'turn/start turn')
    this.commitTurnId(string(turn.id, 'turn/start turn id'))

    const completed = await this.guarded(completion.promise, signal)
    const terminal = object(completed.turn, 'turn/completed turn')
    if (isContextWindowExceeded(terminal)) {
      const usage = this.currentUsage()
      this.turnCompleted = undefined
      this.turnSignal = undefined
      this.turnId = undefined
      return {
        output: this.collectOutput(),
        stopReason: 'max-tokens',
        ...usage === undefined ? {} : { usage },
        ...this.generatedImages.length === 0 ? {} : { generatedImages: [...this.generatedImages] },
      }
    }
    const status = terminal.status
    if (status !== 'completed') {
      const detail = status === 'failed'
        ? `: ${JSON.stringify(terminal.error)}`
        : ''
      throw new Error(`dsh-codex-app-server: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.collectOutput()
    if (output.length === 0 && this.generatedImages.length === 0) {
      throw new Error('dsh-codex-app-server: Codex completed without a final answer')
    }
    const usage = this.currentUsage()
    this.turnCompleted = undefined
    this.turnSignal = undefined
    this.turnId = undefined
    return {
      output,
      stopReason: 'completed',
      ...usage === undefined ? {} : { usage },
      ...this.generatedImages.length === 0 ? {} : { generatedImages: [...this.generatedImages] },
    }
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /**
   * The best non-commentary answer observed so far, preserving exact bytes.
   * @returns the selected final or nullable-phase text blocks, if any.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastFinalAnswer ?? this.lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /** Read usage after asynchronous notification callbacks had a chance to update it. */
  private currentUsage(): TokenUsage | undefined {
    return this.lastUsage
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('dsh-codex-app-server: app-server protocol stream closed'))
  }

  private observePendingTurnId(id: string): void {
    if (this.turnCompleted === undefined) {
      throw new Error('dsh-codex-app-server: app-server referenced a turn before turn/start')
    }
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      // A stale frame from the previous turn on a persistent thread (its id
      // was already committed) is dropped; any other mismatch is a protocol
      // error on the current turn.
      if (id === this.lastCommittedTurnId) return
      throw new Error('dsh-codex-app-server: app-server referenced conflicting turns')
    }
    this.pendingTurnId = id
  }

  private commitTurnId(id: string): void {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('dsh-codex-app-server: turn/start response did not match the active turn')
    }
    this.turnId = id
    this.lastCommittedTurnId = id
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(notification.method, notification.params)
    }
  }

  private validateRunIds(params: JsonObject, nullableTurn = false): void {
    if (params.threadId !== this.threadId) {
      throw new Error('dsh-codex-app-server: app-server request referenced another thread')
    }
    if (nullableTurn && params.turnId === null) return
    const id = string(params.turnId, 'server request turn id')
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      return
    }
    if (id !== this.turnId) {
      throw new Error('dsh-codex-app-server: app-server request referenced another turn')
    }
  }

  private handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
        case 'item/permissions/requestApproval':
        case 'item/tool/requestUserInput':
        case 'mcpServer/elicitation/request': {
          this.validateRunIds(params, method === 'mcpServer/elicitation/request')
          const canResolve = method === 'item/commandExecution/requestApproval'
            || method === 'item/fileChange/requestApproval'
            || method === 'item/permissions/requestApproval'
          if (canResolve) {
            const request: CodexApprovalRequest = {
              method,
              threadId: params.threadId as string,
              turnId: params.turnId as string,
              params,
              signal: this.turnSignal as AbortSignal,
            }
            this.onItem?.({
              type: 'approval_request',
              stage: 'approval-requested',
              threadId: request.threadId,
              turnId: request.turnId,
              ...typeof params.itemId === 'string' ? { itemId: params.itemId } : {},
              approvalMethod: method,
              toolName: method,
              raw: params,
            })
            const decision = this.resolveApproval === undefined
              ? approvalDecision(this.approval, params)
              : this.resolveApproval(request)
            return Promise.resolve(decision).then((answer) => {
              this.onItem?.({
                type: 'approval_decision',
                stage: 'approval-decided',
                threadId: request.threadId,
                turnId: request.turnId,
                ...typeof params.itemId === 'string' ? { itemId: params.itemId } : {},
                approvalMethod: method,
                approvalDecision: answer,
                toolName: method,
                raw: params,
              })
              return approvalResponse(method, answer, params)
            })
          }
          if (method === 'item/tool/requestUserInput') {
            return Promise.resolve({ answers: {} })
          }
          return Promise.resolve({ action: 'decline', content: null, _meta: null })
        }
        default:
          throw new Error(`dsh-codex-app-server: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  private activeNotificationTurn(
    method: string,
    params: JsonObject,
  ): { threadId: string; turnId: string } | undefined {
    const threadId = string(params.threadId, `${method} thread id`)
    if (threadId !== this.threadId) return undefined
    const turnId = string(params.turnId, `${method} turn id`)
    if (this.turnId === undefined) {
      if (this.turnCompleted !== undefined) {
        this.observePendingTurnId(turnId)
        this.earlyTurnNotifications.push({ method, params })
      }
      return undefined
    }
    return turnId === this.turnId ? { threadId, turnId } : undefined
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      const turn = object(params.turn, 'turn/started turn')
      if (this.turnCompleted !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const active = this.activeNotificationTurn(method, params)
      if (active === undefined) return
      const item = object(params.item, `${method} item`)
      const normalized = normalizeItem(item)
      if (normalized !== null) {
        if (method === 'item/completed' && normalized.type === 'agent_message') {
          const text = normalized.text as string
          const phase = normalized.phase as string | null
          if (phase === 'final_answer') {
            this.lastFinalAnswer = text
          } else if (phase === null) {
            this.lastUnphasedAnswer = text
          } else if (phase !== 'commentary') {
            throw new Error(`dsh-codex-app-server: app-server returned an unknown agent message phase ${JSON.stringify(phase)}`)
          }
        }
        if (method === 'item/completed' && normalized.generatedImage !== undefined) {
          this.generatedImages.push(normalized.generatedImage)
        }
        const time = method === 'item/started' ? params.startedAtMs : params.completedAtMs
        this.onItem?.({
          ...normalized,
          stage: method === 'item/started' ? 'item-started' : 'item-completed',
          threadId: active.threadId,
          turnId: active.turnId,
          ...typeof item.id === 'string' ? { itemId: item.id } : {},
          ...typeof time === 'number' ? { timeMs: time } : {},
        })
      }
      return
    }
    if (method === 'item/agentMessage/delta'
      || method === 'item/reasoning/summaryTextDelta'
      || method === 'item/reasoning/textDelta'
      || method === 'item/commandExecution/outputDelta'
      || method === 'item/fileChange/outputDelta'
      || method === 'item/fileChange/patchUpdated'
      || method === 'item/mcpToolCall/progress'
      || method === 'thread/tokenUsage/updated') {
      const active = this.activeNotificationTurn(method, params)
      if (active === undefined) return
      if (method === 'thread/tokenUsage/updated') {
        const tokenUsage = object(params.tokenUsage, 'thread token usage')
        const usage = normalizeTokenUsage(tokenUsage.last)
        this.lastUsage = usage
        this.onItem?.({
          type: 'token_usage',
          stage: 'token-usage',
          threadId: active.threadId,
          turnId: active.turnId,
          usage,
          raw: params,
        })
        return
      }
      const itemId = typeof params.itemId === 'string' ? params.itemId : undefined
      if (method === 'item/fileChange/patchUpdated') {
        this.onItem?.({
          type: 'fileChange',
          stage: 'item-delta',
          threadId: active.threadId,
          turnId: active.turnId,
          ...itemId === undefined ? {} : { itemId },
          toolName: 'fileChange',
          toolArguments: { changes: Array.isArray(params.changes) ? params.changes : [] },
          raw: params,
        })
        return
      }
      if (method === 'item/mcpToolCall/progress') {
        this.onItem?.({
          type: 'mcpToolCall',
          stage: 'item-delta',
          threadId: active.threadId,
          turnId: active.turnId,
          ...itemId === undefined ? {} : { itemId },
          toolResult: string(params.message, `${method} message`),
          raw: params,
        })
        return
      }
      const delta = string(params.delta, `${method} delta`)
      const shared = {
        stage: 'item-delta' as const,
        threadId: active.threadId,
        turnId: active.turnId,
        ...itemId === undefined ? {} : { itemId },
        raw: params,
      }
      if (method === 'item/agentMessage/delta') {
        this.onItem?.({ ...shared, type: 'agent_message_delta', text: delta })
      } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
        this.onItem?.({
          ...shared,
          type: 'reasoning_delta',
          reasoning: delta,
          reasoningKind: method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'content',
        })
      } else {
        this.onItem?.({
          ...shared,
          type: method.startsWith('item/fileChange/') ? 'fileChange' : 'commandExecution',
          toolName: method.startsWith('item/fileChange/') ? 'fileChange' : 'commandExecution',
          toolResult: delta,
        })
      }
      return
    }
    if (method !== 'turn/completed') return
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.turnCompleted
    if (turnCompleted === undefined) return
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({ method, params })
      return
    }
    if (id !== this.turnId) return
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) {
      throw new Error(`dsh-codex-app-server: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve(params)
  }
}
