import { reduce } from './reducer';
import type { ChatEvent } from './normalizer';
import type { StorageMutation } from './storage/types';
import type { Message, Part } from '@/types/opencode.gen';

describe('reduce', () => {
  describe('message.updated', () => {
    it('produces upsert_message mutation', () => {
      const info = { id: 'msg-1', sessionID: 'ses-1', role: 'user' } as Message;
      const event: ChatEvent = { type: 'message.updated', info };

      const result = reduce(event);

      expect(result).toEqual<StorageMutation[]>([{ type: 'upsert_message', info }]);
    });
  });

  describe('message.part.updated', () => {
    it('produces upsert_part', () => {
      const part = { id: 'part-1', sessionID: 'ses-1', messageID: 'msg-1', type: 'text' } as Part;
      const event: ChatEvent = { type: 'message.part.updated', part };

      const result = reduce(event);

      expect(result).toEqual<StorageMutation[]>([
        { type: 'upsert_part', messageId: 'msg-1', part },
      ]);
    });
  });

  describe('message.part.removed', () => {
    it('produces delete_part mutation', () => {
      const event: ChatEvent = {
        type: 'message.part.removed',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'part-1',
      };

      const result = reduce(event);

      expect(result).toEqual<StorageMutation[]>([
        { type: 'delete_part', messageId: 'msg-1', partId: 'part-1' },
      ]);
    });
  });

  describe('message.part.delta', () => {
    it('produces apply_delta mutation', () => {
      const event: ChatEvent = {
        type: 'message.part.delta',
        sessionId: 'ses-1',
        messageId: 'msg-1',
        partId: 'part-1',
        field: 'text',
        delta: 'hello ',
      };

      const result = reduce(event);

      expect(result).toEqual<StorageMutation[]>([
        {
          type: 'apply_delta',
          messageId: 'msg-1',
          partId: 'part-1',
          field: 'text',
          delta: 'hello ',
        },
      ]);
    });
  });
});
