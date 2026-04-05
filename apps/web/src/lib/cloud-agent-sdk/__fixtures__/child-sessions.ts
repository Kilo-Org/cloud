import type { Fixture } from './types';
import {
  createEventHelpers,
  sessionInfo,
  userMsg,
  assistantMsg,
  textPart,
  toolPart,
} from './helpers';

const { createEvent, kilocode } = createEventHelpers();

const childSessions: Fixture = {
  name: 'child-sessions',
  description: 'root + child session with tool delegation and child messages',
  events: [
    // Root session created, goes busy
    kilocode('session.created', { info: sessionInfo('ses-1') }),
    kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }),

    // User message on root
    kilocode('message.updated', { info: userMsg('msg-1', 'ses-1') }),
    kilocode('message.part.updated', { part: textPart('p-1', 'msg-1', 'do something') }),

    // Assistant message with tool part on root
    kilocode('message.updated', { info: assistantMsg('msg-2', 'msg-1', 'ses-1') }),
    kilocode('message.part.updated', {
      part: toolPart('p-2', 'msg-2', 'task', 'ses-1', {
        state: { status: 'running', input: { description: 'subtask' }, time: { start: 1 } },
      }),
    }),

    // Child session created
    kilocode('session.created', {
      info: sessionInfo('child-1', { parentID: 'ses-1' }),
    }),

    // Child session goes busy — should NOT start streaming (already streaming from root)
    kilocode('session.status', { sessionID: 'child-1', status: { type: 'busy' } }),

    // Child produces a user message and assistant message
    kilocode('message.updated', { info: userMsg('msg-3', 'child-1') }),
    kilocode('message.part.updated', {
      part: textPart('p-3', 'msg-3', 'subtask prompt', 'child-1'),
    }),
    kilocode('message.updated', {
      info: assistantMsg('msg-4', 'msg-3', 'child-1'),
    }),
    kilocode('message.part.updated', {
      part: textPart('p-4', 'msg-4', 'subtask response', 'child-1'),
    }),

    // Child session completes (tool result)
    kilocode('session.status', { sessionID: 'child-1', status: { type: 'idle' } }),

    // Tool part updated with result
    kilocode('message.part.updated', {
      part: toolPart('p-2', 'msg-2', 'task', 'ses-1', {
        state: {
          status: 'completed',
          input: { description: 'subtask' },
          output: 'done',
          time: { start: 1, end: 2 },
        },
      }),
    }),

    // Root session completes
    createEvent('complete', {}),
  ],
  expected: {
    messageIds: ['msg-1', 'msg-2', 'msg-3', 'msg-4'],
    parts: {
      'msg-1': [{ id: 'p-1', type: 'text', text: 'do something' }],
      'msg-2': [{ id: 'p-2', type: 'tool', tool: 'task' }],
      'msg-3': [{ id: 'p-3', type: 'text', text: 'subtask prompt' }],
      'msg-4': [{ id: 'p-4', type: 'text', text: 'subtask response' }],
    },
  },
};

export { childSessions };
