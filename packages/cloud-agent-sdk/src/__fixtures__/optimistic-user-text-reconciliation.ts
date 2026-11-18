import type { Fixture } from './types';
import { createEventHelpers, sessionInfo, userMsg, textPart } from './helpers';

const { kilocode } = createEventHelpers();

const prompt = 'Build a sample project overview with two sections.';
const messageId = 'msg_00000000000000000000000001';
const optimisticPartId = 'prt_00000000000000000000000002';
const authoritativePartId = 'prt_00000000000000000000000001';

const optimisticUserTextReconciliation: Fixture = {
  name: 'optimistic-user-text-reconciliation',
  description: 'authoritative user text part replaces an optimistic text part with a different id',
  events: [
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('message.updated', {
      info: userMsg(messageId, 'ses-1', { time: { created: 1772214640111 } }),
    }),
    kilocode('message.part.updated', {
      part: { ...textPart(optimisticPartId, messageId, prompt), synthetic: true },
    }),
    kilocode('message.part.updated', {
      part: { ...textPart(authoritativePartId, messageId, prompt), time: { start: 1772214640152 } },
    }),
  ],
  expected: {
    messageIds: [messageId],
    parts: {
      [messageId]: [
        { id: authoritativePartId, type: 'text', text: prompt, time: { start: 1772214640152 } },
      ],
    },
  },
};

export { optimisticUserTextReconciliation };
