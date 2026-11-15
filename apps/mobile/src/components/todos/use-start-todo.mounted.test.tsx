import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OrganizationsModule from '@kilocode/app-shared/organizations';
import { i18n } from '@/i18n';
import { AGENT_SESSION_NAV_GUARD_MS } from '@/components/agents/agent-session-nav-guard';
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
  focusEffects: [] as (() => void)[],
  // The memberships the hook resolves the list's role from.
  orgs: [] as { organizationId: string; role?: string }[],
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: state.push }),
  useFocusEffect: (effect: () => void) => {
    state.focusEffects.push(effect);
  },
}));
vi.mock('sonner-native', () => ({ toast: { error: state.toastError } }));
// The toast adapter announces through `react-native`'s AccessibilityInfo,
// which this harness does not build.
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: () => undefined },
}));
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
// The hook resolves the list's role from the shared membership list through
// the organization query chain, which this harness does not mount. The real
// `isMoneyRole` rule is applied to whatever role a case sets.
vi.mock('@/lib/hooks/use-organization-queries', async () => {
  const { canManageOrganizationBilling } = await vi.importActual<typeof OrganizationsModule>(
    '@kilocode/app-shared/organizations'
  );
  return {
    isMoneyRole: canManageOrganizationBilling,
    useOrgBoundary: () => ({ orgs: state.orgs }),
  };
});

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
  state.focusEffects = [];
  state.startAgent.mockReset();
  state.link.mockReset();
  state.invalidate.mockReset();
  state.navigate.mockReset();
  state.push.mockReset();
  state.toastError.mockReset();
  state.orgs = [];
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
  vi.restoreAllMocks();
});

async function start(startList: typeof list = list) {
  await act(async () => {
    await mounted().startNow(todo, startList);
  });
}

/** Re-renders after a case changes what the membership list holds. */
function rerender() {
  act(() => {
    renderer?.update(createElement(Probe, { holder }));
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
    // The adapter forwards the options argument, so a refusal with no step is
    // still this call reaching the toast.
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith('No credits left', undefined);
    expect(mounted().startingTodoId).toBeNull();
  });

  it('offers the plan step with the trial refusal to a role that can change the plan', async () => {
    state.orgs = [{ organizationId: 'organization-1', role: 'owner' }];
    rerender();
    state.startAgent.mockResolvedValue({
      ok: false,
      message: i18n.t('common.organizationTrialEndedBilling'),
      trialRefusal: true,
    });

    await start();

    expect(state.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ canManageBilling: true })
    );
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('common.organizationTrialEndedBilling'),
      { action: { label: i18n.t('organization.hub.manageBilling'), onClick: expect.any(Function) } }
    );
    // The role was read for the list's organization, so the step opens that
    // organization's billing rather than the device's selection.
    const [, options] = state.toastError.mock.calls.at(-1) as [
      string,
      { action: { onClick: () => void } } | undefined,
    ];
    options?.action.onClick();
    expect(state.push).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/organization/billing?org=organization-1'
    );
    expect(state.navigate).not.toHaveBeenCalled();
    expect(mounted().startingTodoId).toBeNull();
  });

  it('keeps the owner-naming refusal and no step for a role that cannot change the plan', async () => {
    state.orgs = [{ organizationId: 'organization-1', role: 'member' }];
    rerender();
    state.startAgent.mockResolvedValue({
      ok: false,
      message: i18n.t('common.organizationTrialEnded'),
      trialRefusal: true,
    });

    await start();

    expect(state.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ canManageBilling: false })
    );
    expect(state.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('common.organizationTrialEnded'),
      undefined
    );
    expect(state.navigate).not.toHaveBeenCalled();
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
  it('opens review once on rapid presses and again after the guard window', () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    act(() => {
      mounted().review(todo, list);
      mounted().review(todo, list);
    });

    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push.mock.calls[0]?.[0]).toContain('/(app)/agent-chat/new?organizationId=');

    nowSpy.mockReturnValue(now + AGENT_SESSION_NAV_GUARD_MS);
    act(() => {
      mounted().review(todo, list);
    });

    expect(state.push).toHaveBeenCalledTimes(2);
  });

  it('opens review again when its screen regains focus', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now());

    act(() => {
      mounted().review(todo, list);
      mounted().review(todo, list);
    });
    expect(state.push).toHaveBeenCalledTimes(1);

    act(() => {
      for (const effect of state.focusEffects) {
        effect();
      }
      mounted().review(todo, list);
    });

    expect(state.push).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});
