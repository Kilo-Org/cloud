import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AGENTS_SESSIONS_INDEX_HREF } from '@/lib/agents-sessions-route';
import { i18n } from '@/i18n';
import { QueryError } from '@/components/query-error';
import { SessionPermanentError } from './session-permanent-error';

const router = vi.hoisted(() => ({ dismissTo: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('./restored-route-fallback', () => ({ RestoredRouteFallback: 'RestoredRouteFallback' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalArrowLeft: 'DirectionalArrowLeft',
}));
vi.mock('@/components/empty-state', () => ({ StateAction: 'StateAction' }));
// The body of the shared state is another suite's; this one reads the state it
// asks for, so the stub forwards the recovery slot it was handed.
vi.mock('@/components/query-error', () => ({
  QueryError: ({ action }: { action?: ReactNode }) => action ?? null,
}));

function mountCard(retry?: () => void): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionPermanentError, {
        variant: 'not-found',
        title: 'Session not found',
        message: 'This session is no longer available.',
        retry,
        isRetrying: false,
        restoredRouteOpen: false,
      })
    );
  });
  if (!ref.current) {
    throw new Error('the terminal card did not mount');
  }
  return ref.current;
}

describe('SessionPermanentError recovery', () => {
  it('offers the way back to the sessions and returns to the sessions index', () => {
    const renderer = mountCard();
    const actions = renderer.root.findAll(node => String(node.type) === 'StateAction');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.props.label).toBe(i18n.t('agentChat.session.backToSessions'));

    act(() => {
      (actions[0]?.props.onPress as () => void)();
    });
    expect(router.dismissTo).toHaveBeenCalledWith(AGENTS_SESSIONS_INDEX_HREF);
  });

  it('leaves the retry slot to the denial a retry can clear', () => {
    const retry = vi.fn();
    const renderer = mountCard(retry);
    expect(renderer.root.findAll(node => String(node.type) === 'StateAction')).toHaveLength(0);
    const error = renderer.root.findByType(QueryError);
    expect(error.props.onRetry).toBe(retry);
    expect(error.props.action).toBeUndefined();
  });
});
