import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CurrentTodos } from './current-todos';

import { CurrentTaskList } from './CurrentTaskList';

Object.assign(globalThis, { React });

const pending = { content: 'Pending task', status: 'pending' as const };
const active = { content: 'Active task', status: 'in_progress' as const };
const done = { content: 'Finished task', status: 'completed' as const };

function render(todos: CurrentTodos | null): string {
  return renderToStaticMarkup(React.createElement(CurrentTaskList, { todos }));
}

describe('CurrentTaskList', () => {
  it('renders nothing without a compact task list', () => {
    expect(render(null)).toBe('');
    expect(
      render({
        shown: [],
        completed: 0,
        total: 0,
        hiddenBefore: 0,
        hiddenAfter: 0,
        sourcePartId: 'p',
      })
    ).toBe('');
  });

  it('shows only the active task and progress until the checklist is opened', () => {
    const html = render({
      shown: [pending, active, done],
      completed: 1,
      total: 3,
      hiddenBefore: 0,
      hiddenAfter: 0,
      sourcePartId: 'p',
    });

    expect(html).toContain('aria-label="1 of 3 tasks completed"');
    expect(html).toContain('Active task');
    expect(html).not.toContain('Pending task');
    expect(html).not.toContain('Finished task');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it('keeps hidden counts out of the status row', () => {
    const html = render({
      shown: [active],
      completed: 1,
      total: 4,
      hiddenBefore: 1,
      hiddenAfter: 2,
      sourcePartId: 'p',
    });

    expect(html).not.toContain('1 earlier task hidden');
    expect(html).not.toContain('2 later tasks hidden');
    expect(html).toContain('aria-label="1 of 4 tasks completed"');
  });

  it('reduces a completed list to the task count with a checkmark', () => {
    const html = render({
      shown: [done],
      completed: 1,
      total: 1,
      hiddenBefore: 0,
      hiddenAfter: 0,
      sourcePartId: 'p',
    });

    expect(html).toContain('aria-label="1 of 1 tasks completed"');
    expect(html).toContain('lucide-check');
    expect(html).not.toContain('Finished task');
    expect(html).toContain('aria-expanded="false"');
  });
});
