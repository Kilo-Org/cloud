import type { AssistantMessage } from '@/types/opencode.gen';
import type { Part, StoredMessage, ToolPart } from './types';
import { getCurrentTodos } from './current-todos';

function toolPart(id: string, state: ToolPart['state'], tool = 'todowrite'): ToolPart {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'message-1',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state,
  };
}

function completedPart(id: string, todos: unknown, metadata: Record<string, unknown> = {}) {
  return toolPart(id, {
    status: 'completed',
    input: { todos },
    output: '',
    title: 'todowrite',
    metadata,
    time: { start: 1, end: 2 },
  });
}

function runningPart(id: string, todos: unknown) {
  return toolPart(id, {
    status: 'running',
    input: { todos },
    time: { start: 1 },
  });
}

function message(id: string, parts: Part[]): StoredMessage {
  const info: AssistantMessage = {
    id,
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'user-1',
    modelID: 'test-model',
    providerID: 'test-provider',
    mode: 'code',
    agent: 'test-agent',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { info, parts };
}

const pending = { content: 'Pending task', status: 'pending', priority: 'medium' };
const active = { content: 'Active task', status: 'in_progress', priority: 'high' };
const done = { content: 'Finished task', status: 'completed', priority: 'low' };

describe('getCurrentTodos', () => {
  it('returns the latest native todowrite list from chat history', () => {
    const messages = [
      message('m1', [completedPart('p1', [pending, active])]),
      message('m2', [completedPart('p2', [pending, active, done])]),
    ];

    expect(getCurrentTodos(messages)).toMatchObject({
      sourcePartId: 'p2',
      shown: [pending, active, done],
      completed: 1,
      total: 3,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it('replays the latest todowrite inside a multi-part assistant message', () => {
    const messages = [
      message('m1', [
        { id: 'text-1', sessionID: 'ses-1', messageID: 'm1', type: 'text', text: 'working' },
        completedPart('p1', [pending]),
        completedPart('p2', [active]),
      ]),
    ];

    expect(getCurrentTodos(messages)?.shown).toEqual([active]);
  });

  it('prefers the compact metadata view for the visible subset', () => {
    const changed = { ...active, changed: true };
    const messages = [
      message('m1', [
        completedPart('p1', [pending], {
          todos: [done, active, pending],
          view: { mode: 'compact', todos: [changed], hiddenBefore: 1, hiddenAfter: 1 },
        }),
      ]),
    ];

    expect(getCurrentTodos(messages)).toMatchObject({
      shown: [changed],
      completed: 1,
      total: 3,
      hiddenBefore: 1,
      hiddenAfter: 1,
    });
  });

  it('uses optimistic input while the native todowrite is still running', () => {
    const messages = [message('m1', [runningPart('p1', [active])])];

    expect(getCurrentTodos(messages)).toMatchObject({
      sourcePartId: 'p1',
      shown: [active],
      total: 1,
    });
  });

  it('ignores error todowrite parts and falls back to the last applied list', () => {
    const messages = [
      message('m1', [completedPart('p1', [pending])]),
      message('m2', [
        toolPart('p2', {
          status: 'error',
          input: { todos: [done] },
          error: 'boom',
          time: { start: 1, end: 2 },
        }),
      ]),
    ];

    expect(getCurrentTodos(messages)?.shown).toEqual([pending]);
  });

  it('keeps each chat isolated to the messages it is given', () => {
    const chatA = [message('a', [completedPart('p1', [pending])])];
    const chatB = [message('b', [completedPart('p2', [done])])];

    expect(getCurrentTodos(chatA)?.shown).toEqual([pending]);
    expect(getCurrentTodos(chatB)?.shown).toEqual([done]);
  });

  it('returns null without a native todowrite list or with malformed input', () => {
    expect(getCurrentTodos([])).toBeNull();
    expect(getCurrentTodos([message('m1', [completedPart('p1', [])])])).toMatchObject({
      total: 0,
    });
    expect(getCurrentTodos([message('m1', [completedPart('p1', null)])])).toBeNull();
    expect(
      getCurrentTodos([
        message('m1', [
          toolPart(
            'p1',
            {
              status: 'completed',
              input: {},
              output: '',
              title: 'read',
              metadata: {},
              time: { start: 1, end: 2 },
            },
            'read'
          ),
        ]),
      ])
    ).toBeNull();
  });
});
