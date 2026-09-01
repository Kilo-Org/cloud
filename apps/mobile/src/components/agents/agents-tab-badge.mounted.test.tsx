/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the React Native tree without a DOM. */
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attentionKv,
  CountSurfaces,
  fetchSessions,
  key,
  organization,
  sessions,
} from './agents-tab-badge.test-helpers';
import { makeQueryFn, makeTestQueryClient } from '@/lib/active-sessions-live-sync.test-helpers';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import {
  __flushSessionAttentionWritesForTests,
  __hydrateSessionAttentionForTests,
  __peekSessionAttentionForTests,
  __resetSessionAttentionForTests,
  ackSessionAttention,
  isAttentionAcked,
  SESSION_ATTENTION_EXPIRY_MS,
} from '@/lib/session-attention';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

type Mount = Awaited<ReturnType<typeof renderWithProviders>>;
const mounts: Mount[] = [];

async function mount(queryClient = makeTestQueryClient()) {
  const result = await renderWithProviders(createElement(CountSurfaces), { queryClient });
  mounts.push(result);
  return result;
}

function isHostType(item: ReactTestInstance, type: string) {
  return typeof item.type === 'string' && item.type === type;
}

function agentsOptions(renderer: Mount['renderer']) {
  return renderer.root.find(
    item => isHostType(item, 'TabScreen') && item.props.name === '(2_agents)'
  ).props.options as { title: string; tabBarBadge?: number; tabBarAccessibilityLabel: string };
}

function expectCounts(renderer: Mount['renderer'], count?: number, liveCount?: number) {
  const header = renderer.root.find(item => isHostType(item, 'ScreenHeader'));
  expect(header.props.eyebrow).toBe(liveCount === undefined ? undefined : `${liveCount} LIVE`);
  const options = agentsOptions(renderer);
  expect(options.tabBarBadge).toBe(count);
  expect(options.title).toBe('Agents');
  expect(options.tabBarAccessibilityLabel).toBe(
    count ? `Agents, ${count} needs input, tab, 2 of 3` : 'Agents, tab, 2 of 3'
  );
}

function rerender({ renderer, queryClient }: Mount) {
  act(() => {
    renderer.update(
      createElement(QueryClientProvider, { client: queryClient }, createElement(CountSurfaces))
    );
  });
}

async function updateSessions(result: Mount, rows: ActiveSession[]) {
  await act(async () => {
    result.queryClient.setQueryData(key(organization.organizationId), { sessions: rows });
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

describe('Agents needs-input badge and shared live count', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    organization.organizationId = null;
    organization.isLoaded = true;
    fetchSessions.mockReset();
    fetchSessions.mockReturnValue(new Promise(() => undefined));
    attentionKv.getItem.mockReset().mockResolvedValue(null);
    __resetSessionAttentionForTests();
  });

  afterEach(async () => {
    for (const result of mounts) {
      result.unmount();
    }
    mounts.length = 0;
    await __flushSessionAttentionWritesForTests();
  });

  it.each([1, 3, 4, 12])(
    'updates to %i from the shared cache while Home has focus',
    async count => {
      const queryClient = makeTestQueryClient();
      await queryClient.fetchQuery({
        queryKey: key(),
        queryFn: makeQueryFn(),
      });
      const result = await mount(queryClient);
      expectCounts(result.renderer, undefined, 0);
      expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
      expect(queryClient.getQueryCache().find({ queryKey: key() })?.getObserversCount()).toBe(2);
      await updateSessions(result, [
        ...sessions(Array.from({ length: count }, () => 'question')),
        ...sessions(['question', 'permission'], 'other-org'),
        { id: 'unenriched', connectionId: 'cli', title: 'Unknown owner', status: 'question' },
      ]);
      expectCounts(result.renderer, count, count);
      await updateSessions(result, []);
      expectCounts(result.renderer, undefined, 0);
    }
  );

  it('counts only questions and permissions while the live header counts every status', async () => {
    const result = await mount();
    await updateSessions(result, sessions(['busy', 'idle', 'retry', 'question', 'permission']));
    expectCounts(result.renderer, 2, 5);
    await updateSessions(result, sessions(['busy', 'idle', 'retry']));
    expectCounts(result.renderer, undefined, 3);
  });

  it.each(['question', 'permission'] as const)(
    'reduces the badge immediately after a %s acknowledgment',
    async status => {
      const result = await mount();
      await updateSessions(result, sessions([status, status, 'busy']));
      expectCounts(result.renderer, 2, 3);
      const cached = result.queryClient.getQueryData(key());
      const fetchCount = fetchSessions.mock.calls.length;
      act(() => {
        ackSessionAttention('personal-0');
      });
      expectCounts(result.renderer, 1, 3);
      expect(__peekSessionAttentionForTests('personal-0')).toEqual({ raiseId: status });
      act(() => {
        ackSessionAttention('personal-1');
      });
      expectCounts(result.renderer, undefined, 3);
      expect(result.queryClient.getQueryData(key())).toBe(cached);
      expect(fetchSessions).toHaveBeenCalledTimes(fetchCount);
    }
  );

  it.each(['busy', 'permission'] as const)(
    'reconciles question -> %s -> question without mounted rows',
    async status => {
      const result = await mount();
      await updateSessions(result, sessions(['question']));
      act(() => {
        ackSessionAttention('personal-0');
      });
      expectCounts(result.renderer, undefined, 1);
      await updateSessions(result, sessions([status]));
      expect(isAttentionAcked('personal-0', 'question')).toBe(false);
      expectCounts(result.renderer, status === 'permission' ? 1 : undefined, 1);
      await updateSessions(result, sessions(['question']));
      expectCounts(result.renderer, 1, 1);
    }
  );

  it.each([
    { status: 'question', raiseId: 'question' },
    { status: 'question', raiseId: null },
    { status: 'busy', raiseId: 'question' },
  ] as const)(
    'reconciles hydrated $raiseId acknowledgments against $status',
    async ({ status, raiseId }) => {
      const pending = Promise.withResolvers<string | null>();
      attentionKv.getItem.mockReturnValueOnce(pending.promise);
      const hydration = __hydrateSessionAttentionForTests();
      const result = await mount();
      await updateSessions(result, sessions([status, 'permission']));
      expectCounts(result.renderer, status === 'question' ? 2 : 1, 2);
      await act(async () => {
        pending.resolve(
          JSON.stringify([
            {
              sessionId: 'personal-0',
              raiseId,
              status: 'question',
              ackedAt: Date.now(),
              expiresAt: Date.now() + SESSION_ATTENTION_EXPIRY_MS,
            },
          ])
        );
        await hydration;
      });
      expectCounts(result.renderer, 1, 2);
      expect(__peekSessionAttentionForTests('personal-0')).toEqual(
        status === 'question' ? { raiseId: 'question' } : undefined
      );
      await updateSessions(result, sessions(['question', 'permission']));
      expectCounts(result.renderer, status === 'question' ? 1 : 2, 2);
    }
  );

  it('hides counts while the initial live query loads', async () => {
    const { renderer, queryClient } = await mount();
    expect(queryClient.getQueryState(key())?.fetchStatus).toBe('fetching');
    expectCounts(renderer);
  });

  it('hides cached counts and disables fetching until the organization loads', async () => {
    organization.isLoaded = false;
    const queryClient = makeTestQueryClient();
    queryClient.setQueryData(
      key(),
      { sessions: sessions(['question', 'permission', 'busy']) },
      { updatedAt: 0 }
    );
    const result = await mount(queryClient);
    expectCounts(result.renderer);
    expect(queryClient.getQueryState(key())?.fetchStatus).toBe('idle');
    fetchSessions.mockResolvedValue({
      sessions: sessions(['question', 'permission', 'busy', 'idle']),
    });
    organization.isLoaded = true;
    rerender(result);
    await waitFor(
      () =>
        result.renderer.root.find(item => isHostType(item, 'ScreenHeader')).props.eyebrow ===
        '4 LIVE'
    );
    expectCounts(result.renderer, 2, 4);
  });

  it('hides counts after a fetch failure and restores them after refetch', async () => {
    fetchSessions.mockRejectedValue(new TypeError('Network request failed'));
    const { renderer, queryClient } = await mount();
    await waitFor(() => queryClient.getQueryState(key())?.status === 'error');
    expectCounts(renderer);
    fetchSessions.mockResolvedValue({ sessions: sessions(['question', 'busy']) });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: key() });
    });
    await waitFor(() => agentsOptions(renderer).tabBarBadge === 1);
    expectCounts(renderer, 1, 2);
  });

  it('hides counts without removing cached sessions after a refetch failure', async () => {
    const queryClient = makeTestQueryClient();
    const cachedRows = sessions(['question', 'permission', 'busy']);
    queryClient.setQueryData(key(), { sessions: cachedRows });
    const { renderer } = await mount(queryClient);
    expectCounts(renderer, 2, 3);
    fetchSessions.mockRejectedValue(new TypeError('Network request failed'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: key() });
    });
    await waitFor(() => agentsOptions(renderer).tabBarBadge === undefined);
    expectCounts(renderer);
    expect(queryClient.getQueryData(key())).toEqual({ sessions: cachedRows });
    fetchSessions.mockResolvedValue({ sessions: sessions(['question', 'busy', 'idle', 'retry']) });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: key() });
    });
    await waitFor(() => agentsOptions(renderer).tabBarBadge === 1);
    expectCounts(renderer, 1, 4);
  });

  it('never carries counts or acknowledgments across organization loading or authorization failure', async () => {
    organization.organizationId = 'org-a';
    const queryClient = makeTestQueryClient();
    queryClient.setQueryData(key('org-a'), {
      sessions: sessions(['question', 'permission', 'busy'], 'org-a'),
    });
    const result = await mount(queryClient);
    expectCounts(result.renderer, 2, 3);
    act(() => {
      ackSessionAttention('org-a-0');
    });
    expectCounts(result.renderer, 1, 3);
    const pending = Promise.withResolvers<{ sessions: ActiveSession[] }>();
    fetchSessions.mockReturnValue(pending.promise);
    organization.organizationId = 'org-b';
    rerender(result);
    expectCounts(result.renderer);
    expect(queryClient.getQueryState(key('org-b'))?.fetchStatus).toBe('fetching');
    act(() => {
      pending.reject(Object.assign(new Error('Unauthorized'), { data: { code: 'UNAUTHORIZED' } }));
    });
    await waitFor(() => queryClient.getQueryState(key('org-b'))?.status === 'error');
    expectCounts(result.renderer);
    act(() => {
      queryClient.setQueryData(key('org-a'), { sessions: sessions(['busy'], 'org-a') });
    });
    expectCounts(result.renderer);
    expect(isAttentionAcked('org-a-0', 'question')).toBe(true);
    fetchSessions.mockResolvedValue({
      sessions: [
        ...sessions(['question', 'busy'], 'org-b'),
        ...sessions(['busy'], 'org-a'),
        ...sessions(['permission']),
      ],
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: key('org-b') });
    });
    await waitFor(() => agentsOptions(result.renderer).tabBarBadge === 1);
    expectCounts(result.renderer, 1, 2);
    expect(isAttentionAcked('org-a-0', 'question')).toBe(true);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: key('org-a') })
        ?.getObserversCount()
    ).toBe(0);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: key('org-b') })
        ?.getObserversCount()
    ).toBe(2);
  });
});
