import type { Fixture } from './types';
import { createEventHelpers } from './helpers';

const { createEvent } = createEventHelpers();

const messageDeliveryExhausted: Fixture = {
  name: 'message-delivery-exhausted',
  description:
    'cloud.message.queued followed by cloud.message.failed with reason=exhausted clears pending delivery state',
  events: [
    createEvent('cloud.message.queued', {
      messageId: 'msg-queued-1',
      executionId: 'exe-1',
      content: 'hi',
      delivery: 'queued',
    }),
    createEvent('cloud.message.failed', {
      messageId: 'msg-queued-1',
      executionId: 'exe-1',
      delivery: 'queued',
      attempts: 5,
      error: 'Failed to flush queued message after 5 attempts',
    }),
  ],
  expected: {
    messageIds: [],
    parts: {},
    pendingMessages: {},
  },
};

export { messageDeliveryExhausted };
