/**
 * Shared Codex app-server child lifecycle: spawn the real app-server through
 * the subprocess seam, wire it, and dispose to whole-tree quiescence.
 *
 * @module dsh-codex/app-server/run
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CodexAppServerWire } from './wire.ts'
import type { CodexApprovalHandler, CodexApprovalPolicy, CodexItemEvent } from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/**
 * Resolve the fixed app-server command for a platform.
 *
 * Windows npm and pnpm installs expose `codex.cmd`, which requires `cmd.exe`;
 * the argv is constant so no task or configuration text enters the
 * shell boundary.
 * @param platform - host platform used to select the executable boundary.
 * @returns argv for the fixed Codex app-server command.
 */
export function codexAppServerArgv(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', 'codex', 'app-server', '--stdio']
    : ['codex', 'app-server', '--stdio']
}

/** Fully resolved inputs for one Codex app-server child. */
export interface CodexChildSpec {
  /** Parent workspace, also supplied to `thread/start`. */
  readonly cwd: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Unattended answer to Codex approval requests. */
  readonly approval: CodexApprovalPolicy
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/**
 * Close the private wire, terminate the managed process tree, and wait for the
 * subprocess owner to prove it is gone.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeCodexChild(
  wire: CodexAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change tree ownership below.
  }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * One started app-server child and the local cancellation race shared by the
 * subagent and LLM seams.
 */
export interface StartedCodexChild {
  readonly wire: CodexAppServerWire
  readonly child: SubprocessHandle
  /** Rejects when the child exits before the run settles. */
  readonly processFailure: Promise<never>
  /** Local cancellation controller; aborting it interrupts the remote turn. */
  readonly runAbort: AbortController
  /** Request cancellation for the parent signal; idempotent. */
  readonly requestCancel: () => void
  /** Dispose the child to whole-tree quiescence. */
  readonly dispose: () => Promise<void>
}

/**
 * Spawn the fixed `codex app-server --stdio` child, wire its stdio, and set up
 * the process-failure and local-cancellation race the seams share.
 * @param spec - child spawn facts.
 * @param signal - parent cancellation; aborting it interrupts the child.
 * @param label - seam name for diagnostics.
 * @param onItem - per-completed-item event sink (forwarded to the wire).
 * @param resolveApproval - approval handler (forwarded to the wire).
 * @returns the started child and its race primitives.
 */
export function startCodexChild(
  spec: CodexChildSpec,
  signal: AbortSignal,
  label: string,
  onItem?: (item: CodexItemEvent) => void,
  resolveApproval?: CodexApprovalHandler,
): StartedCodexChild {
  const child = spec.spawn({
    argv: codexAppServerArgv(),
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    spec.approval,
    onItem,
    resolveApproval,
  )
  const processFailure: Promise<never> = child.done.then(
    outcome => Promise.reject(new Error(
      `${label}: app-server exited before the run settled `
      + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
    )),
    (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
  )
  // A normal post-result dispose also closes the process. Keep that expected
  // late rejection observed after the result race has already settled.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error(`${label}: run cancelled locally`))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  signal.addEventListener('abort', onAbort, { once: true })

  return {
    wire,
    child,
    processFailure,
    runAbort,
    requestCancel,
    dispose: async () => {
      signal.removeEventListener('abort', onAbort)
      await disposeCodexChild(wire, child)
    },
  }
}
