import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Static import: the route module is under test, and its `vi.mock`-ed
// dependencies register before this import resolves.
import TodoListRoute from '@/app/(app)/todos/[list-id]';

/**
 * Creating a list pushes the list and retires the settings sheet beneath it
 * from the sheet's own listener — which a covered screen never runs. The list
 * owns the retire instead, and this suite pins the pair of route names it
 * judges: the sheet above it, and the tabs navigator beneath the sheet.
 */

const retireMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ 'list-id': 'list-1' }),
}));

vi.mock('@/lib/navigation/retire-covered-source', () => ({
  useRetireCoveredSource: retireMock,
}));

// The list screen is not the subject: only the covered-source judgment is.
vi.mock('@/components/todos/todo-list-screen', () => ({ TodoListScreen: 'TodoListScreen' }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));

beforeEach(() => {
  retireMock.mockReset();
});

describe('TodoListRoute retire-covered-source', () => {
  it('retires the settings sheet with the tabs navigator as its guard', () => {
    act(() => {
      TestRenderer.create(createElement(TodoListRoute));
    });

    expect(retireMock).toHaveBeenCalledTimes(1);
    expect(retireMock).toHaveBeenCalledWith('todos/list-settings', '(tabs)');
  });
});
