import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type {
  CodexApprovalRequest, CodexItemEvent, CodexItemStage,
} from './app-server/index.ts'

/** Lifecycle point represented by one durable Codex observation. */
export type CodexObservationStage = CodexItemStage

/** Codex approval methods bridged to the Harness approval service. */
export type CodexApprovalMethod = CodexApprovalRequest['method']

/** Replayable Codex child-agent observation persisted in a Harness session. */
export type CodexTurnItemData = Omit<CodexItemEvent, 'raw'>

/** Final per-turn usage persisted for diagnostics and token metering. */
export type CodexTokenUsageData = TokenUsage

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records one replayable Codex child-agent lifecycle observation.
     * @param data - stable identity, lifecycle, and normalized display facts.
     */
    'codex/turn-item': CodexTurnItemData
    /**
     * Records final per-turn Codex usage for diagnostics and token metering.
     * @param data - disjoint input, output, cache, and reasoning token buckets.
     */
    'codex/token-usage': TokenUsage
  }
}
