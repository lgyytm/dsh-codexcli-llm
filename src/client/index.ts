import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CodexObservationView } from './CodexObservationView.tsx'
import { codexObservationDefinition } from './observation-definition.ts'
import { en, NS, zh, type CodexObservationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Codex child-agent observation copy. */
    'codex-observation': CodexObservationKey
  }
}

/** Required services for the Codex Conversation Definition and renderer. */
export const inject = ['slots', 'locale', 'conversationEvents']

/** Register replayable Codex child-agent observations in the Chat view. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(codexObservationDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-codex: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'codex-observation',
    locale: NS,
  }, CodexObservationView))
}
