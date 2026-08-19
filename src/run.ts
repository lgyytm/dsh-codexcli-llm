/**
 * Session-scoped Codex child lifecycle: one `codex app-server --stdio` child
 * per DSH session, one persistent thread reused across turns, with full item
 * event reporting and injectable approval handling.
 *
 * @module dsh-codex/run
 */

import { CodexAppServerWire, startCodexChild } from './app-server/index.ts'
import type {
  CodexApprovalHandler,
  CodexChildSpec,
  CodexItemEvent,
  CodexModelInfo,
  CodexReasoningSummary,
  CodexTurnResult,
} from './app-server/index.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

export type { CodexChildSpec, CodexItemEvent } from './app-server/index.ts'

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/** One session's live Codex connection: a child, a persistent thread, and a wire. */
export interface CodexSessionConnection {
  /** The app-server wire. */
  readonly wire: CodexAppServerWire
  /** Rejects when the child exits before the run settles. */
  readonly processFailure: Promise<never>
  /** The child handle, for diagnostics. */
  readonly child: SubprocessHandle
  /** Interrupt the currently active Codex turn; idempotent for this connection. */
  readonly requestCancel: () => void
  /** Abort the connection; idempotent. */
  readonly dispose: () => Promise<void>
  /** The persistent thread id, once created. */
  readonly threadId: string | undefined
}

/**
 * Read the picker-visible model catalog from a short-lived app-server child.
 * The child is always terminated before this operation settles.
 * @param spec - child spawn facts.
 * @param signal - catalog cancellation.
 * @returns the product model catalog.
 */
export async function listCodexModels(
  spec: CodexChildSpec,
  signal: AbortSignal,
): Promise<readonly CodexModelInfo[]> {
  const started = startCodexChild(spec, signal, 'llm-codex-model-list')
  let models: readonly CodexModelInfo[] | undefined
  let failure: Error | undefined
  try {
    started.wire.start()
    await Promise.race([started.wire.initialize(signal), started.processFailure])
    models = await Promise.race([started.wire.listModels(signal), started.processFailure])
  } catch (error: unknown) {
    failure = thrown(error)
  }
  try {
    await started.dispose()
  } catch (error: unknown) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, thrown(error)],
        'llm-codex: model listing failed and app-server cleanup also failed',
      )
    }
    throw thrown(error)
  }
  if (failure !== undefined) throw failure
  /* v8 ignore next -- the operation either assigns models or records failure. */
  if (models === undefined) throw new Error('llm-codex: model listing settled without a result')
  return models
}

/**
 * Start one session's Codex connection: spawn the app-server child and create
 * a persistent (non-ephemeral) thread.
 * @param spec - child spawn facts.
 * @param signal - session cancellation; aborting it tears the child down.
 * @param model - explicit model override; absent uses Codex configuration.
 * @param onItem - per-completed-item event sink.
 * @param resolveApproval - approval handler; absent falls back to the policy.
 * @returns the live connection.
 */
export async function startCodexSession(
  spec: CodexChildSpec,
  signal: AbortSignal,
  model?: string,
  onItem?: (item: CodexItemEvent) => void,
  resolveApproval?: CodexApprovalHandler,
): Promise<CodexSessionConnection> {
  const started = startCodexChild(spec, signal, 'llm-codex', onItem, resolveApproval)
  const wire = started.wire
  try {
    wire.start()
    await Promise.race([wire.initialize(signal), started.processFailure])
    await Promise.race([
      wire.startThread(spec.cwd, signal, false, model),
      started.processFailure,
    ])
    return {
      wire,
      processFailure: started.processFailure,
      child: started.child,
      requestCancel: started.requestCancel,
      dispose: started.dispose,
      threadId: wire.thread(),
    }
  } catch (error: unknown) {
    try {
      await started.dispose()
    } catch (disposeError: unknown) {
      /* v8 ignore next 3 -- both the start error and a failing cleanup are surfaced together */
      throw new AggregateError(
        [thrown(error), thrown(disposeError)],
        'llm-codex: session start failed and app-server cleanup also failed',
      )
    }
    throw thrown(error)
  }
}

/**
 * Run one model request turn on a session's persistent thread.
 * @param connection - the live session connection.
 * @param text - the translated request text.
 * @param signal - local cancellation for the turn.
 * @param reasoningSummary - reasoning-summary policy sent to `turn/start`.
 * @param model - explicit model override; absent uses the thread model.
 * @returns the final answer blocks and reported per-turn usage.
 */
export async function runCodexSessionTurn(
  connection: CodexSessionConnection,
  text: string,
  signal: AbortSignal,
  reasoningSummary: CodexReasoningSummary,
  model?: string,
): Promise<CodexTurnResult> {
  const onAbort = (): void => { connection.requestCancel() }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    const completed = await Promise.race([
      connection.wire.runTurn([text], signal, reasoningSummary, model),
      connection.processFailure,
    ])
    if (completed.stopReason === 'max-tokens') {
      throw new Error('llm-codex: Codex context window exceeded')
    }
    return completed
  } catch (error: unknown) {
    if (!signal.aborted) throw error
    try {
      await connection.dispose()
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [thrown(error), thrown(disposeError)],
        'llm-codex: turn cancellation failed to clean up the app-server child',
      )
    }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
