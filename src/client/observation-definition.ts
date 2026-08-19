import type { CodexTurnItemData } from '../observation-types.ts'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Renderer-ready lifecycle state for one Codex child-agent item. */
export interface CodexObservationData extends CodexTurnItemData {
  /** Durable event ordering anchor for the item row. */
  readonly seq: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One replayable Codex reasoning or tool lifecycle. */
    'codex-observation': CodexObservationData
  }
}

function visible(data: CodexTurnItemData): boolean {
  return data.itemId !== undefined
    && (data.type === 'reasoning'
      || data.type === 'reasoning_delta'
      || data.toolName !== undefined
      || data.approvalMethod !== undefined)
}

function dataOf(match: ConversationMatch): CodexTurnItemData {
  if (match.event.type !== 'codex/turn-item') {
    throw new Error('codex-observation requires codex/turn-item')
  }
  return match.event.data
}

function appendText(previous: unknown, addition: unknown): unknown {
  return typeof previous === 'string' && typeof addition === 'string'
    ? previous + addition
    : addition
}

/** Remove Codex summary lines' transport-only Markdown bold delimiters for plain-text Think rendering. */
function displayReasoning(value: string, kind: CodexTurnItemData['reasoningKind']): string {
  if (kind !== 'summary') return value
  return value.replaceAll('**', '')
}

function updateState(
  state: CodexObservationData,
  next: CodexTurnItemData,
): CodexObservationData {
  const delta = next.stage === 'item-delta'
  const updated: CodexObservationData = {
    ...state,
    ...next,
    seq: state.seq,
    ...next.reasoning === undefined
      ? {}
      : {
        reasoning: displayReasoning(delta && state.reasoningKind === next.reasoningKind
          ? String(appendText(state.reasoning ?? '', next.reasoning))
          : next.reasoning, next.reasoningKind),
        ...next.reasoningKind === undefined ? {} : { reasoningKind: next.reasoningKind },
      },
    ...next.toolResult === undefined
      ? {}
      : { toolResult: delta ? appendText(state.toolResult ?? '', next.toolResult) : next.toolResult },
  }
  if ((next.stage === 'approval-requested' || next.stage === 'approval-decided')
    && state.toolName !== undefined) {
    return { ...updated, type: state.type, toolName: state.toolName }
  }
  return updated
}

/** Codex child-agent item lifecycle projected as one keyed Chat row. */
export const codexObservationDefinition: ConversationNodeDefinition<CodexObservationData> = {
  kind: 'codex-observation',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'codex/turn-item' || !visible(event.data)) return null
    return {
      id: `${event.data.turnId}:${event.data.itemId as string}`,
      role: event.data.stage === 'item-started' ? 'start' : 'update',
    }
  },
  start: (_context, match) => {
    const data = dataOf(match)
    if (data.stage !== 'item-started') {
      throw new Error('codex-observation start requires item-started')
    }
    return { ...data, seq: match.event.seq }
  },
  update: (context, match) => updateState(context.state, dataOf(match)),
  publication: match => match.event.type === 'codex/turn-item' && match.event.data.stage === 'item-delta'
    ? 'animation-frame'
    : 'immediate',
  buildViewNode: (context: ConversationNodeContext<CodexObservationData>) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'codex-observation',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}
