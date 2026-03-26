import type { Fixture } from './types';
import { createEventHelpers, sessionInfo, userMsg, assistantMsg } from './helpers';

const { createEvent, kilocode } = createEventHelpers();

const interruption: Fixture = {
  name: 'interruption',
  description: 'streaming interrupted mid-delta — partial text preserved, stream goes idle',
  events: [
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }),

    kilocode('message.updated', { info: userMsg('msg-1') }),
    kilocode('message.updated', { info: assistantMsg('msg-2', 'msg-1') }),

    // Partial deltas — no final snapshot
    kilocode('message.part.delta', {
      sessionID: 'ses-1',
      messageID: 'msg-2',
      partID: 'p-1',
      field: 'text',
      delta: 'I will start by',
    }),
    kilocode('message.part.delta', {
      sessionID: 'ses-1',
      messageID: 'msg-2',
      partID: 'p-1',
      field: 'text',
      delta: ' reading the',
    }),

    // Interrupted before completing
    createEvent('interrupted', {}),
  ],
  expected: {
    messageIds: ['msg-1', 'msg-2'],
    parts: {
      'msg-1': [],
      'msg-2': [{ id: 'p-1', type: 'text', text: 'I will start by reading the' }],
    },
  },
};

export { interruption };
