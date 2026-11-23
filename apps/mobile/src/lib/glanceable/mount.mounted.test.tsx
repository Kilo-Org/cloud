/* eslint-disable max-lines -- one cohesive mounted suite: the hold and the settle re-derive share the same publisher fake */
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTestQueryClient } from '@/lib/active-sessions-live-sync.test-helpers';
import { act } from '@/test/renderer';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

import { GlanceablePublisherMount } from './mount';

// The publisher is the effect under test: it is what carries a derive to the
// OS surfaces. The sinks, persistence and native widgets behind it are not, so
// the factory returns a recorder instead of the real state machine.
const publisherMock = vi.hoisted(() => ({
  handleSessions: vi.fn(),
  handleFetchStarted: vi.fn(),
  handleFetchError: vi.fn(),
  dispose: vi.fn(),
  redraw: vi.fn(),
}));

// The ack store is the input under test. The component reads the phase through
// the hook, and its mount effect reads the snapshot at derive time, so one
// value answers both.
const attentionPhase = vi.hoisted(() => ({
  current: 'ready' as 'loading' | 'ready' | 'failed',
}));

// One fixed tray key: this suite seeds and reads one cache, and the
// organization input the module derives is not what it asserts.
const sessionsKey = vi.hoisted(() => [['activeSessions', 'list'], { input: {}, type: 'query' }]);

// The followed-card sync runs from the same derive as the publish, before the
// hold returns, so it is this suite's positive proof that the derive really ran
// while the store was loading.
const followCardsMock = vi.hoisted(() => vi.fn());

vi.mock('./create-publisher', () => ({ createGlanceablePublisher: () => publisherMock }));
vi.mock('./session-follow', () => ({ syncFollowedSessionCards: followCardsMock }));
vi.mock('./fixture-harness', () => ({ setGlanceableFixtureScope: vi.fn() }));
// The restore pass reaches SecureStore and the native widget; this suite is
// about the ack store's phase, so it settles immediately.
vi.mock('./persist', () => ({
  persistGlanceableSink: { id: 'persist' },
  restorePersistedGlanceable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./widget-store', () => ({
  migrateWidgetStoreAccessibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./home-widget-refresh', () => ({
  clearHomeWidgetRefresh: vi.fn().mockResolvedValue(undefined),
  restoreNativeHomeWidgetData: vi.fn().mockResolvedValue(undefined),
  syncHomeWidgetRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), off: vi.fn() } }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1' }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'account', isLoading: false, restoreFailed: false }),
}));
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        // One fixed key: this suite seeds and reads one tray cache, and the
        // organization input the module derives is not what it asserts.
        queryKey: () => sessionsKey,
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/lib/session-attention', () => ({
  getHydrationSnapshot: () => attentionPhase.current,
  isAttentionAcked: () => false,
  sessionNeedsInput: (status: string | null | undefined) =>
    status === 'question' || status === 'permission',
  useSessionAttentionHydration: () => attentionPhase.current,
  useSessionAttentionRevision: () => 0,
}));

/** One waiting raise, the row `resolveAnsweredRaises` would count as active. */
const RAISE = {
  id: 'ses_wait',
  connectionId: 'cli',
  title: 'Waiting',
  status: 'question',
  organizationId: null,
};

type Mount = RenderWithProvidersResult;
const mounts: Mount[] = [];

/** Re-render through the provider the harness built, so the mount keeps its client. */
function rerender(result: Mount): void {
  act(() => {
    result.renderer.update(
      createElement(
        QueryClientProvider,
        { client: result.queryClient },
        createElement(GlanceablePublisherMount)
      )
    );
  });
}

describe('GlanceablePublisherMount ack hydration hold', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    attentionPhase.current = 'ready';
    followCardsMock.mockReset();
    publisherMock.handleSessions.mockReset();
    publisherMock.handleFetchStarted.mockReset();
    publisherMock.handleFetchError.mockReset();
    publisherMock.dispose.mockReset();
  });

  afterEach(() => {
    for (const result of mounts) {
      result.unmount();
    }
    mounts.length = 0;
  });

  it('publishes nothing while the ack store loads, then re-derives once it settles', async () => {
    // A store that has not hydrated answers "not acked" for every raise, so a
    // derive now would publish a raise the person already answered.
    attentionPhase.current = 'loading';
    const result = await renderWithProviders(createElement(GlanceablePublisherMount), {
      queryClient: makeTestQueryClient(),
    });
    mounts.push(result);
    result.queryClient.setQueryData(sessionsKey, { sessions: [RAISE] });

    // The mount really saw the cache change while loading: the followed-card
    // sync runs from the same derive, so it is the positive signal that the
    // hold — not an absent subscribe — is what withheld the publish.
    await waitFor(() => followCardsMock.mock.calls.length > 0);
    expect(publisherMock.handleSessions).not.toHaveBeenCalled();
    expect(followCardsMock).toHaveBeenCalled();

    // Settled: the phase change re-runs the ack effect, which derives from the
    // cache this mount already holds.
    attentionPhase.current = 'ready';
    rerender(result);
    await waitFor(() => publisherMock.handleSessions.mock.calls.length === 1);
    expect(publisherMock.handleSessions).toHaveBeenCalledTimes(1);
    const [[rows]] = publisherMock.handleSessions.mock.calls as [[{ id: string }[]]];
    expect(rows.map(row => row.id)).toEqual(['ses_wait']);
  });
});
