import { onlineManager } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  findConfigureRows,
  flushIdle,
  keys,
  mountProfile,
  nodeCount,
  nodeCountWithChildren,
  organizationsQueryFn,
  providersQueryFn,
} from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { act } from '@/test/renderer';
import { createTestQueryClient, waitFor } from '@/test/render-with-providers';

// The account row opens the shared picker through the press-burst guard; this
// suite asserts the screen, not the navigation, so the guarded push is a stub.
vi.mock('@/lib/hooks/use-single-push-route', () => ({
  useSinglePushRoute: () => vi.fn(),
}));

describe('ProfileScreen linked accounts', () => {
  beforeEach(() => {
    vi.useRealTimers();
    onlineManager.setOnline(true);
    providersQueryFn.mockReset();
    organizationsQueryFn.mockReset();
  });

  it('keeps the rows and shows the stale line when a refetch fails after a successful read', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.providers, {
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    queryClient.setQueryData(keys.organizations, []);
    providersQueryFn.mockRejectedValue(new Error('accounts read failed'));

    const { renderer, unmount } = await mountProfile(queryClient);
    expect(findConfigureRows(renderer.root, 'GitHub')).toHaveLength(1);

    // The deferred read enables only after the idle latch opens, and
    // `refetchQueries` skips a disabled query.
    flushIdle();
    await act(async () => {
      await Promise.resolve();
    });

    // A refetch the person did not start (focus, reconnect) fails over the
    // retained rows.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: keys.providers });
    });
    await waitFor(
      () =>
        nodeCountWithChildren(
          renderer.root,
          'Text',
          i18n.t('agents.sessionList.couldNotRefresh')
        ) === 1
    );

    // Rows stay the answer: a stale marker, not a claim the accounts could not load.
    expect(findConfigureRows(renderer.root, 'GitHub')).toHaveLength(1);
    expect(nodeCount(renderer.root, 'QueryError')).toBe(0);
    expect(
      nodeCountWithChildren(renderer.root, 'Text', i18n.t('profile.couldNotLoadAccounts'))
    ).toBe(0);

    unmount();
  });
});
