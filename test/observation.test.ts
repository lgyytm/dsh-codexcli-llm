import { describe, expect, it } from 'vitest'
import { codexObservationDefinition } from '../src/client/observation-definition.ts'
import type { CodexTurnItemData } from '../src/observation-types.ts'

function match(data: CodexTurnItemData, seq: number): never {
  return {
    event: { type: 'codex/turn-item', data, seq },
  } as never
}

describe('Codex reasoning observation', () => {
  it('removes Codex summary bold delimiters from the plain-text Think display', () => {
    const start: CodexTurnItemData = {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'reasoning',
      type: 'reasoning',
      stage: 'item-started',
      reasoning: '',
      reasoningKind: 'summary',
    }
    const state = codexObservationDefinition.start({} as never, match(start, 1))
    const next = codexObservationDefinition.update({ state } as never, match({
      ...start,
      type: 'reasoning_delta',
      stage: 'item-delta',
      reasoning: '**Inspecting the project files**',
    }, 2))

    expect(next.reasoning).toBe('Inspecting the project files')
  })
})
