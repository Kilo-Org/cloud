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

  it('renders pending, in-progress and completed states with progress', () => {
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
    expect(html).toContain('Pending task');
    expect(html).toContain('Finished task');
    expect(html).toContain('Pending:');
    expect(html).toContain('In progress:');
    expect(html).toContain('Completed:');
    expect(html).toContain('aria-expanded="true"');
  });

  it('surfaces the compact view hidden counts', () => {
    const html = render({
      shown: [active],
      completed: 1,
      total: 4,
      hiddenBefore: 1,
      hiddenAfter: 2,
      sourcePartId: 'p',
    });

    expect(html).toContain('1 earlier task hidden');
    expect(html).toContain('2 later tasks hidden');
  });
});
