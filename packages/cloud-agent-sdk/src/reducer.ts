/**
 * Pure reducer: ChatEvent → StorageMutation[].
 */
import type { ChatEvent } from './normalizer';
import type { StorageMutation } from './storage/types';

function reduce(event: ChatEvent): StorageMutation[] {
  switch (event.type) {
    case 'message.updated':
      return [{ type: 'upsert_message', info: event.info }];
    case 'message.part.updated':
      return [
        {
          type: 'upsert_part',
          messageId: event.part.messageID,
          part: event.part,
          ...(event.time === undefined ? {} : { eventTime: event.time }),
        },
      ];
    case 'message.part.delta':
      return [
        {
          type: 'apply_delta',
          messageId: event.messageId,
          partId: event.partId,
          field: event.field,
          delta: event.delta,
        },
      ];
    case 'message.part.removed':
      return [{ type: 'delete_part', messageId: event.messageId, partId: event.partId }];
    case 'message.removed':
      return [{ type: 'delete_message', messageId: event.messageId }];
  }
}

export { reduce };
