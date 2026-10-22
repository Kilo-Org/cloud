import type { Fixture } from './types';
import { createEventHelpers, sessionInfo, userMsg, textPart } from './helpers';

const { kilocode } = createEventHelpers();

const prompt = 'Build a sample project overview with two sections.';
const messageId = 'msg_00000000000000000000000001';
const syntheticPartId = `${messageId}-text`;
const realPartId = 'prt_00000000000000000000000001';

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
