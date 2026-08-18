/**
 * Shared Codex app-server protocol wire and child lifecycle for the subagent
 * and LLM seams. Both `dsh-subagent-codex` and `dsh-llm-codex` spawn the real
 * `codex app-server --stdio` child through the subprocess seam, speak the same
 * JSON-RPC product protocol, and dispose the same way; this library owns that
 * shared surface once.
 *
 * @module dsh-codex/app-server
 */

export { CodexAppServerWire } from './wire.ts'
export type { CodexApprovalDecision, CodexApprovalHandler, CodexApprovalPolicy, CodexApprovalRequest, CodexGeneratedImage, CodexItemDetails, CodexItemEvent, CodexItemStage, CodexModelInfo, CodexReasoningSummary, CodexTurnResult } from './wire.ts'
export { normalizeItem, normalizeTokenUsage } from './wire.ts'
export {
  codexAppServerArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
  startCodexChild,
} from './run.ts'
export type { CodexChildSpec, StartedCodexChild } from './run.ts'
