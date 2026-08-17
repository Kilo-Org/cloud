import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type TodoTask } from '../tool-list-model';
import { TodoTaskRows } from './todo-task-rows';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/icons', () => ({
  Circle: 'Circle',
  CircleCheck: 'CircleCheck',
  CircleDot: 'CircleDot',
  CircleX: 'CircleX',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    good: '#278150',
    foreground: '#14130F',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));

function makeTask(overrides: Partial<TodoTask>): TodoTask {
  return { content: 'task', status: 'pending', ...overrides };
}

function render(tasks: readonly TodoTask[], truncated = false): React.ReactElement {
  // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
  return TodoTaskRows({ tasks, truncated }) as React.ReactElement;
}

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];
  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as Record<string, unknown>;
      if (typeof value.type === 'function') {
        walk((value.type as React.FunctionComponent<unknown>)(props));
      }
      walk(props.children);
    }
  }
  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

function mustFindByType(root: React.ReactElement, type: string): React.ReactElement {
  const element = findByType(root, type)[0];
  if (!element) {
    throw new Error(`missing ${type} element`);
  }
  return element;
}

describe('TodoTaskRows', () => {
  it('renders one row per task with a selectable text', () => {
    const root = render([makeTask({}), makeTask({ content: 'second' })]);
    const rows = findAll(
      root,
      el =>
        el.type === 'View' &&
        ((el.props as { className?: string }).className?.includes('border-b') ?? false)
    );
    expect(rows).toHaveLength(2);
    expect(findByType(root, 'SelectableText')).toHaveLength(2);
  });

  it('maps each status to its icon with the planned color', () => {
    const tasks: TodoTask[] = [
      makeTask({ content: 'done', status: 'completed' }),
      makeTask({ content: 'doing', status: 'in_progress' }),
      makeTask({ content: 'queued', status: 'pending' }),
      makeTask({ content: 'cancelled', status: 'cancelled' }),
    ];
    const root = render(tasks);

    const check = mustFindByType(root, 'CircleCheck');
    expect((check.props as { color?: string }).color).toBe('#278150');

    const dot = mustFindByType(root, 'CircleDot');
    expect((dot.props as { color?: string }).color).toBe('#14130F');

    const circle = mustFindByType(root, 'Circle');
    expect((circle.props as { color?: string }).color).toBe('#6F6A61');

    const x = mustFindByType(root, 'CircleX');
    expect((x.props as { color?: string }).color).toBe('#6F6A61');
  });

  it('renders a selectable text per status row', () => {
    const tasks: TodoTask[] = [
      makeTask({ content: 'done', status: 'completed' }),
      makeTask({ content: 'doing', status: 'in_progress' }),
      makeTask({ content: 'queued', status: 'pending' }),
      makeTask({ content: 'gone', status: 'cancelled' }),
    ];
    const root = render(tasks);
    const texts = findByType(root, 'SelectableText');
    expect(texts).toHaveLength(4);
    const values = texts.map(el => (el.props as { children?: string }).children);
    expect(values).toEqual(['done', 'doing', 'queued', 'gone']);
  });

  it('mutes and strikes through only cancelled tasks', () => {
    const tasks: TodoTask[] = [
      makeTask({ content: 'active', status: 'pending' }),
      makeTask({ content: 'gone', status: 'cancelled' }),
    ];
    const root = render(tasks);
    const texts = findByType(root, 'SelectableText');

    const active = texts[0];
    const cancelled = texts[1];
    if (!active || !cancelled) {
      throw new Error('missing SelectableText elements');
    }
    const activeClass = (active.props as { className?: string }).className ?? '';
    const cancelledClass = (cancelled.props as { className?: string }).className ?? '';

    expect(activeClass).not.toContain('line-through');
    expect(cancelledClass).toContain('line-through');
    expect(cancelledClass).toContain('text-muted-foreground');
  });

  it('shows the Truncated marker when truncated', () => {
    const root = render([makeTask({})], true);
    const labels = findByType(root, 'Text').filter(
      el => (el.props as { accessibilityLabel?: string }).accessibilityLabel === 'Content truncated'
    );
    expect(labels).toHaveLength(1);
  });

  it('omits the Truncated marker when not truncated', () => {
    const root = render([makeTask({})], false);
    const labels = findByType(root, 'Text').filter(
      el => (el.props as { accessibilityLabel?: string }).accessibilityLabel === 'Content truncated'
    );
    expect(labels).toHaveLength(0);
  });
});
