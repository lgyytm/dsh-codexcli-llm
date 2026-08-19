import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { CodexAppServerWire, CodexTurnResult } from '../src/app-server/index.ts'
import { runCodexSessionTurn } from '../src/run.ts'
import type { CodexSessionConnection } from '../src/run.ts'

const completed: CodexTurnResult = {
  output: [{ type: 'text', text: 'done' }],
  stopReason: 'completed',
}

describe('persistent Codex turn cancellation', () => {
  it('interrupts and disposes the connection when a later reused turn is aborted', async () => {
    let turn = 0
    const wire = {
      runTurn: (_texts: readonly string[], signal: AbortSignal): Promise<CodexTurnResult> => {
        turn += 1
        if (turn === 1) return Promise.resolve(completed)
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => { reject(signal.reason) }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    } as CodexAppServerWire
    const requestCancel = vi.fn()
    const dispose = vi.fn(() => Promise.resolve())
    const connection: CodexSessionConnection = {
      wire,
      processFailure: new Promise<never>(() => {}),
      child: {} as SubprocessHandle,
      requestCancel,
      dispose,
      threadId: 'thread-1',
    }

    await expect(runCodexSessionTurn(
      connection,
      'first',
      new AbortController().signal,
      'detailed',
    )).resolves.toEqual(completed)

    const controller = new AbortController()
    const pending = runCodexSessionTurn(
      connection,
      'second',
      controller.signal,
      'detailed',
    )
    controller.abort(new Error('user stopped the turn'))

    await expect(pending).rejects.toThrow('user stopped the turn')
    expect(requestCancel).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
