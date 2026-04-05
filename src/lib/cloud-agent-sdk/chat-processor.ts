import { stripPartContentIfFile } from '@/components/cloud-agent-next/types';
import type { ChatEvent } from './normalizer';
import type { SessionStorage } from './storage/types';

type ChatProcessor = {
  process(event: ChatEvent): void;
};

function createChatProcessor(storage: SessionStorage): ChatProcessor {
  return {
    process(event) {
      switch (event.type) {
        case 'message.updated':
          storage.upsertMessage(event.info);
          break;
        case 'message.part.updated': {
          const stripped = stripPartContentIfFile(event.part);
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
