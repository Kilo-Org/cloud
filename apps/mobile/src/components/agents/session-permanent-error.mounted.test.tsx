import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { QueryError } from '@/components/query-error';
import { SessionPermanentError } from './session-permanent-error';

vi.mock('./restored-route-fallback', () => ({ RestoredRouteFallback: 'RestoredRouteFallback' }));
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
  it('leaves the way out to the header, with no action of its own', () => {
    // The screen header draws the back chevron, so a terminal state that
    // repeated it would be the second way out on one surface.
    const renderer = mountCard();

    expect(renderer.root.findByType(QueryError).props.action).toBeUndefined();
    expect(actions(renderer)).toHaveLength(0);
  });

  it.each([true, false])('draws one retry when the denial can clear, loading=%s', isRetrying => {
    const retry = vi.fn<() => void>();
    const renderer = mountCard(retry, isRetrying);
    const [attempt, ...rest] = actions(renderer);
    if (!attempt) {
      throw new Error('the card rendered no retry');
    }
    expect(rest).toHaveLength(0);
    expect(attempt.props.label).toBe(i18n.t('common.retry'));
    expect(attempt.props.loading).toBe(isRetrying);

    act(() => {
      (attempt.props.onPress as () => void)();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps the error body out of the action slot', () => {
    const renderer = mountCard();
    const error = renderer.root.findByType(QueryError);
    expect(error.props.onRetry).toBeUndefined();
  });
});
