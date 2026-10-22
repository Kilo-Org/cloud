import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type TodoList } from '@/lib/todos/todo-types';
import { act, TestRenderer } from '@/test/renderer';

import { type StartTodoControls, useStartTodo } from './use-start-todo';

const state = vi.hoisted(() => ({
  startAgent: vi.fn(),
  link: vi.fn(),
  invalidate: vi.fn(),
  navigate: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: state.push }),
  useFocusEffect: () => undefined,
}));
vi.mock('sonner-native', () => ({ toast: { error: state.toastError } }));
vi.mock('expo-haptics', () => ({
  notificationAsync: async () => {
    await Promise.resolve();
  },
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('@/lib/app-actions/start-agent', () => ({ startAgent: state.startAgent }));
vi.mock('@/lib/hooks/todo-session-link', () => ({ linkStartedTodoSession: state.link }));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: state.invalidate,
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => state.navigate,
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({}) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));

const todo = { id: 'todo-1', title: 'Ship the fix', notes: null };
const list: Pick<TodoList, 'organizationId' | 'gitUrl' | 'mode' | 'model' | 'variant'> = {
  organizationId: 'organization-1',
  gitUrl: 'test/project',
  mode: null,
  model: null,
  variant: null,
};

function Probe({ holder }: Readonly<{ holder: { current: StartTodoControls | null } }>) {
  holder.current = useStartTodo();
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
const holder: { current: StartTodoControls | null } = { current: null };

function mounted() {
  if (!holder.current) {
    throw new Error('useStartTodo has not mounted');
  }
  return holder.current;
}

beforeEach(async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  state.startAgent.mockReset();
  state.link.mockReset();
  state.invalidate.mockReset();
  state.navigate.mockReset();
  state.push.mockReset();
  state.toastError.mockReset();
  state.link.mockResolvedValue(undefined);
  state.invalidate.mockResolvedValue(undefined);
  act(() => {
    renderer = TestRenderer.create(createElement(Probe, { holder }));
  });
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  holder.current = null;
});

async function start(startList: typeof list = list) {
  await act(async () => {
    await mounted().startNow(todo, startList);
  });
}

describe('useStartTodo start now', () => {
  it('opens the started session when the link fails', async () => {
    state.startAgent.mockResolvedValue({ ok: true, sessionId: 'session-1', message: '' });
    state.link.mockRejectedValue(new Error('link failed'));

    await start();

    expect(state.navigate).toHaveBeenCalledExactlyOnceWith('session-1', 'organization-1');
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('todos.item.startRefreshFailed')
    );
    expect(mounted().startingTodoId).toBeNull();
  });

  it('opens the started session when the cache refresh fails', async () => {
    state.startAgent.mockResolvedValue({ ok: true, sessionId: 'session-2', message: '' });
    state.invalidate.mockRejectedValue(new Error('refresh failed'));

    await start();

    expect(state.navigate).toHaveBeenCalledExactlyOnceWith('session-2', 'organization-1');
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('todos.item.startRefreshFailed')
    );
  });

  it('does not navigate or throw when the start itself fails', async () => {
    state.startAgent.mockResolvedValue({ ok: false, message: 'No credits left' });

    await start();

    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith('No credits left');
    expect(mounted().startingTodoId).toBeNull();
  });

  it('reports a thrown start instead of rejecting', async () => {
    state.startAgent.mockRejectedValue(new Error('exploded'));

    await start();

    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith(i18n.t('common.somethingWentWrong'));
    expect(mounted().startingTodoId).toBeNull();
  });

  it('ignores a second start for a to-do that is already starting', async () => {
    const pending = Promise.withResolvers<unknown>();
    state.startAgent.mockReturnValueOnce(pending.promise);

    await act(async () => {
      const first = mounted().startNow(todo, list);
      const second = mounted().startNow(todo, list);
      pending.resolve({ ok: true, sessionId: 'session-3', message: '' });
      await first;
      await second;
    });

    expect(state.startAgent).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith('session-3', 'organization-1');
  });

  it('opens the review route when the list has no repository', async () => {
    await start({ ...list, gitUrl: null });

    expect(state.startAgent).not.toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledTimes(1);
  });
});
