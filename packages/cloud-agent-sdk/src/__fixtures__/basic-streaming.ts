import type { Fixture } from './types';
import { createEventHelpers, sessionInfo, userMsg, assistantMsg, textPart } from './helpers';

const { createEvent, kilocode } = createEventHelpers();

const basicStreaming: Fixture = {
  name: 'basic-streaming',
  description: 'user message → assistant streaming via deltas → final snapshot → complete',
  events: [
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }),
    kilocode('message.updated', { info: userMsg('msg-1') }),
    kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'hello') }),
    kilocode('message.updated', { info: assistantMsg('msg-2', 'msg-1') }),
    kilocode('message.part.delta', {
      sessionID: 'ses-1',
      messageID: 'msg-2',
      partID: 'p-2',
      field: 'text',
      delta: 'Hello',
    }),
    kilocode('message.part.delta', {
      sessionID: 'ses-1',
      messageID: 'msg-2',
      partID: 'p-2',
      field: 'text',
      delta: ' world',
    }),
    kilocode('message.part.updated', { part: textPart('p-2', 'msg-2', 'Hello world') }),
    createEvent('complete', { currentBranch: 'main' }),
  ],
  expected: {
    messageIds: ['msg-1', 'msg-2'],
    parts: {
      'msg-1': [{ id: 'p-1', type: 'text', text: 'hello' }],
      'msg-2': [{ id: 'p-2', type: 'text', text: 'Hello world' }],
    },
  },
};

export { basicStreaming };
