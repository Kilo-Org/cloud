import type { Fixture } from './types';
import {
  createEventHelpers,
  sessionInfo,
  userMsg,
  assistantMsg,
  textPart,
  toolPart,
  stepStartPart,
} from './helpers';

const { createEvent, kilocode } = createEventHelpers();

const toolUseCycle: Fixture = {
  name: 'tool-use-cycle',
  description: 'step-start → text + tool call (pending → running → completed) → step-finish',
  events: [
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }),

    kilocode('message.updated', { info: userMsg('msg-1') }),
    kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'fix the bug') }),

    kilocode('message.updated', { info: assistantMsg('msg-2', 'msg-1') }),

    // Step start
    kilocode('message.part.updated', { part: stepStartPart('p-2', 'msg-2') }),

    // Assistant text via deltas
    kilocode('message.part.delta', {
      sessionID: 'ses-1',
      messageID: 'msg-2',
      partID: 'p-3',
      field: 'text',
      delta: 'I will fix the bug by editing the file.',
    }),
    kilocode('message.part.updated', {
      part: textPart('p-3', 'msg-2', 'I will fix the bug by editing the file.'),
    }),

    // Tool call: pending
    kilocode('message.part.updated', {
      part: toolPart('p-4', 'msg-2', 'edit', 'ses-1'),
    }),

    // Tool call: running
    kilocode('message.part.updated', {
      part: toolPart('p-4', 'msg-2', 'edit', 'ses-1', {
        state: { status: 'running', input: { path: '/src/bug.ts' }, raw: '', time: { start: 1 } },
      }),
    }),

    // Tool call: completed
    kilocode('message.part.updated', {
      part: toolPart('p-4', 'msg-2', 'edit', 'ses-1', {
        state: {
          status: 'completed',
          input: { path: '/src/bug.ts' },
          output: 'file edited',
          raw: '',
          time: { start: 1, end: 2 },
        },
      }),
    }),

    // Step finish
    kilocode('message.part.updated', {
      part: {
        id: 'p-5',
        sessionID: 'ses-1',
        messageID: 'msg-2',
        type: 'step-finish',
        snapshot: 'snapshot-after',
      },
    }),

    createEvent('complete', {}),
  ],
  expected: {
    messageIds: ['msg-1', 'msg-2'],
    parts: {
      'msg-1': [{ id: 'p-1', type: 'text', text: 'fix the bug' }],
      'msg-2': [
        { id: 'p-2', type: 'step-start' },
        { id: 'p-3', type: 'text', text: 'I will fix the bug by editing the file.' },
        { id: 'p-4', type: 'tool', tool: 'edit' },
        { id: 'p-5', type: 'step-finish' },
      ],
    },
  },
};

export { toolUseCycle };
