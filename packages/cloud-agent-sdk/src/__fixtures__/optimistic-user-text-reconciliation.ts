import type { Fixture } from './types';
import { createEventHelpers, sessionInfo, userMsg, textPart } from './helpers';

const { kilocode } = createEventHelpers();

const prompt =
  "I want to build mobile portrait mode friendly interactive birthday invitation for an upcoming 6 year old girl party. Please suggest some cool ideas and let's implement.";
const messageId = 'msg_ca0395def0011t6S1qwxQbPSYB';
const syntheticPartId = `${messageId}-text`;
const realPartId = 'prt_ca0395df1001ez5Rq0YoFEEjdO';

const optimisticUserTextReconciliation: Fixture = {
  name: 'optimistic-user-text-reconciliation',
  description:
    'authoritative user text part replaces synthetic optimistic text part with different id',
  events: [
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('message.updated', {
      info: userMsg(messageId, 'ses-1', { time: { created: 1772214640111 } }),
    }),
    kilocode('message.part.updated', {
      part: { ...textPart(syntheticPartId, messageId, prompt), synthetic: true },
    }),
    kilocode('message.part.updated', {
      part: { ...textPart(realPartId, messageId, prompt), time: { start: 1772214640152 } },
    }),
  ],
  expected: {
    messageIds: [messageId],
    parts: {
      [messageId]: [{ id: realPartId, type: 'text', text: prompt, time: { start: 1772214640152 } }],
    },
  },
};

export { optimisticUserTextReconciliation };
