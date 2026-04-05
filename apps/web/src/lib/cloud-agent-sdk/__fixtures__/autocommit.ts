import type { Fixture } from './types';
import { createEventHelpers, sessionInfo, userMsg, assistantMsg, textPart } from './helpers';

const { createEvent, kilocode } = createEventHelpers();

const autocommit: Fixture = {
  name: 'autocommit',
  description: 'autocommit started → completed with commit hash after assistant finishes',
  events: [
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }),

    kilocode('message.updated', { info: userMsg('msg-1') }),
    kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'fix it') }),

    kilocode('message.updated', {
      info: assistantMsg('msg-2', 'msg-1', 'ses-1', { time: { created: 1, completed: 2 } }),
    }),
    kilocode('message.part.updated', {
      part: textPart('p-2', 'msg-2', 'I fixed the bug.'),
    }),

    // Autocommit lifecycle
    createEvent('autocommit_started', { messageId: 'msg-2', message: 'Committing changes...' }),
    createEvent('autocommit_completed', {
      messageId: 'msg-2',
      success: true,
      commitHash: 'abc123',
      commitMessage: 'fix: resolve the bug',
    }),

    createEvent('complete', {}),
  ],
  expected: {
    messageIds: ['msg-1', 'msg-2'],
    parts: {
      'msg-1': [{ id: 'p-1', type: 'text', text: 'fix it' }],
      'msg-2': [{ id: 'p-2', type: 'text', text: 'I fixed the bug.' }],
    },
  },
};

export { autocommit };
