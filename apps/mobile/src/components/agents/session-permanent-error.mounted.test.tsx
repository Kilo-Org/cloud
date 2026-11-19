import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AGENTS_SESSIONS_INDEX_HREF } from '@/lib/agents-sessions-route';
import { i18n } from '@/i18n';
import { QueryError } from '@/components/query-error';
import { SessionPermanentError } from './session-permanent-error';

const router = vi.hoisted(() => ({ dismissTo: vi.fn(), push: vi.fn() }));
// The stack this card is rendered in, as far as the exit rule reads it: the
// index of the session route above an entry beneath it.
const navigation = vi.hoisted(() => ({ currentIndex: 1, addListener: vi.fn() }));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => ({
    getState: () => ({
      index: navigation.currentIndex,
      routes: [{ key: 'tabs' }, { key: 'session' }].slice(0, navigation.currentIndex + 1),
    }),
    addListener: navigation.addListener.mockReturnValue(() => undefined),
  }),
}));
// `useBackToAgentsSessions` falls back to the stack-safe replacement, whose own
// push-then-retire mechanics are another suite's.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: router.push }),
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('./restored-route-fallback', () => ({ RestoredRouteFallback: 'RestoredRouteFallback' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalArrowLeft: 'DirectionalArrowLeft',
}));
vi.mock('@/components/ui/icons', () => ({ RotateCcw: 'RotateCcw' }));
vi.mock('@/components/empty-state', () => ({ StateAction: 'StateAction' }));
// The body of the shared state is another suite's; this one reads the state it
// asks for, so the stub forwards the recovery slot it was handed.
vi.mock('@/components/query-error', () => ({
  QueryError: ({ action }: { action?: ReactNode }) => action ?? null,
}));

function mountCard(retry?: () => void, isRetrying = false): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionPermanentError, {
        variant: 'not-found',
        title: 'Session not found',
        message: 'This session is no longer available.',
        retry,
        isRetrying,
        restoredRouteOpen: false,
      })
    );
  });
  if (!ref.current) {
    throw new Error('the terminal card did not mount');
  }
  return ref.current;
}

function actions(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'StateAction');
}

describe('SessionPermanentError recovery', () => {
  beforeEach(() => {
    navigation.currentIndex = 1;
    router.dismissTo.mockClear();
    router.push.mockClear();
  });

  it('offers the way back to the sessions and returns to the sessions index', () => {
    const renderer = mountCard();
    const [back] = actions(renderer);
    if (!back) {
      throw new Error('the card rendered no action');
    }
    expect(back.props.label).toBe(i18n.t('agentChat.session.backToSessions'));

    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(router.dismissTo).toHaveBeenCalledWith(AGENTS_SESSIONS_INDEX_HREF);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('takes the route’s place when the session route is the stack’s only route', () => {
    // A cold link opens the session with nothing beneath it: there is no route
    // to dismiss to, so the press pushes the sessions list, and the stack-safe
    // replacement retires this route once that push settles.
    navigation.currentIndex = 0;
    const renderer = mountCard();
    const [back] = actions(renderer);
    if (!back) {
      throw new Error('the card rendered no action');
    }

    act(() => {
      (back.props.onPress as () => void)();
    });
    expect(router.push).toHaveBeenCalledWith(AGENTS_SESSIONS_INDEX_HREF);
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('offers a retry beside the way back, and spins while it runs', () => {
    const retry = vi.fn<() => void>();
    const renderer = mountCard(retry, true);
    const [attempt, back] = actions(renderer);
    if (!attempt || !back) {
      throw new Error('the card rendered fewer than two actions');
    }
    expect(attempt.props.label).toBe(i18n.t('common.retry'));
    expect(attempt.props.loading).toBe(true);
    expect(back.props.label).toBe(i18n.t('agentChat.session.backToSessions'));

    act(() => {
      (attempt.props.onPress as () => void)();
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('keeps the error body out of the action slot', () => {
    const renderer = mountCard();
    const error = renderer.root.findByType(QueryError);
    expect(error.props.onRetry).toBeUndefined();
  });
});
