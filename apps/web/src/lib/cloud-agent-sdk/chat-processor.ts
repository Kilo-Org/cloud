import { stripPartContentIfFile } from './part-utils';
import type { ChatEvent } from './normalizer';
import type { SessionStorage } from './storage/types';
import type { UserMessage, TextPart } from '@/types/opencode.gen';

type ChatProcessor = {
  process(event: ChatEvent): void;
  /**
   * Materialize a synthetic user message from a `cloud.message.queued` server
   * event, unless an authoritative message with the same id already exists.
   * The synthetic message is overwritten when the wrapper later emits the
   * real `message.updated` payload for the same id.
   */
  synthesizeQueuedUserMessage(input: {
    messageId: string;
    sessionId: string;
    content: string | undefined;
  }): void;
};

function hasTextField(part: { text?: string } | unknown): part is { text: string } {
  return typeof part === 'object' && part !== null && 'text' in part;
}

function isSyntheticPart(part: unknown): boolean {
  return (
    typeof part === 'object' && part !== null && 'synthetic' in part && part.synthetic === true
  );
}

function createChatProcessor(storage: SessionStorage): ChatProcessor {
  return {
    process(event) {
      switch (event.type) {
        case 'message.updated':
          storage.upsertMessage(event.info);
          break;
        case 'message.part.updated': {
          const stripped = stripPartContentIfFile(event.part);
          if (hasTextField(stripped) && stripped.text === '' && !isSyntheticPart(stripped)) {
            const existingParts = storage.getParts(stripped.messageID);
            const existing = existingParts.find(p => p.id === stripped.id);
            if (existing && hasTextField(existing) && existing.text.length > 0) {
              break;
            }
          }
          storage.upsertPart(stripped.messageID, stripped);
          break;
        }
        case 'message.part.delta':
          storage.applyPartDelta(event.messageId, event.partId, event.field, event.delta);
          break;
        case 'message.part.removed':
          storage.deletePart(event.messageId, event.partId);
          break;
      }
    },

    synthesizeQueuedUserMessage({ messageId, sessionId, content }) {
      // Empty or missing content can't form a renderable user message; wait for
      // the authoritative `message.updated` payload from the wrapper instead.
      if (!content) return;
      if (storage.getMessageInfo(messageId)) return;

      const syntheticMessage: UserMessage = {
        id: messageId,
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: '',
        model: { providerID: '', modelID: '' },
      };
      storage.upsertMessage(syntheticMessage);

      const syntheticPart: TextPart = {
        id: `${messageId}-text`,
        sessionID: sessionId,
        messageID: messageId,
        type: 'text',
        text: content,
        synthetic: true,
      };
      storage.upsertPart(messageId, syntheticPart);
    },
  };
}

export { createChatProcessor };
export type { ChatProcessor };
