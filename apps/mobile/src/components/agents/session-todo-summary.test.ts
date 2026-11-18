import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { assistantMessage } from './message-bubble-test-utils';
import { selectSessionTodoSummary } from './session-todo-summary';

type Todo = { content: string; status: string };

function todoWrite(
  id: string,
  todos: Todo[],
  status: 'completed' | 'error' = 'completed'
): ToolPart {
  const base = {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: id,
  } as const;
  if (status === 'error') {
    return {
      ...base,
      tool: 'todowrite',
      state: { status: 'error', input: { todos }, error: 'failed', time: { start: 0, end: 1 } },
    };
  }
  return {
    ...base,
    tool: 'todowrite',
    state: {
      status: 'completed',
      input: { todos },
      output: '',
      title: 'todowrite',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function message(id: string, parts: ToolPart[]): StoredMessage {
  return { info: assistantMessage(id).info, parts };
}

describe('selectSessionTodoSummary', () => {
  it('returns null without a todowrite', () => {
    expect(selectSessionTodoSummary([message('m1', [])])).toBeNull();
  });

  it('uses only the latest todowrite and skips a failed one', () => {
    const summary = selectSessionTodoSummary([
      message('m1', [todoWrite('old', [{ content: 'old task', status: 'pending' }])]),
      message('m2', [
        todoWrite('new', [
          { content: 'done', status: 'completed' },
          { content: 'now', status: 'in_progress' },
        ]),
        todoWrite('failed', [{ content: 'never applied', status: 'pending' }], 'error'),
      ]),
    ]);
    expect(summary).toEqual({
      partId: 'new',
      completed: 1,
      total: 2,
      current: { content: 'now', status: 'in_progress' },
    });
  });

  it('drops cancelled tasks from the total and falls back to the first pending task', () => {
    const summary = selectSessionTodoSummary([
      message('m1', [
        todoWrite('list', [
          { content: 'done', status: 'completed' },
          { content: 'dropped', status: 'cancelled' },
          { content: 'next', status: 'pending' },
          { content: 'later', status: 'pending' },
        ]),
      ]),
    ]);
    expect(summary).toMatchObject({
      completed: 1,
      total: 3,
      current: { content: 'next', status: 'pending' },
    });
  });

  it('returns null when the latest list has no open task', () => {
    const summary = selectSessionTodoSummary([
      message('m1', [todoWrite('old', [{ content: 'open', status: 'pending' }])]),
      message('m2', [
        todoWrite('new', [
          { content: 'done', status: 'completed' },
          { content: 'dropped', status: 'cancelled' },
        ]),
      ]),
    ]);
    expect(summary).toBeNull();
  });
});
