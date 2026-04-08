import { stripPartContentIfFile } from '@/components/cloud-agent-next/types';
import type { ChatEvent } from './normalizer';
import type { SessionStorage } from './storage/types';

type ChatProcessor = {
  process(event: ChatEvent): void;
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
  };
}

export { createChatProcessor };
export type { ChatProcessor };
