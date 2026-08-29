/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the existing DOM-free hook harness. */
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { type TRPCQueryKey } from '@trpc/tanstack-react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitHubReposRefresh } from './use-github-repos-refresh';
import {
  resolveRefreshTrigger,
  shouldClearConnectCheckFailed,
  shouldSetConnectCheckFailed,
} from './use-github-repos-refresh-helpers';

const mocks = vi.hoisted(() => ({
  userId: 'user-1',
  platform: 'ios',
  fetch: vi.fn<() => Promise<unknown>>(),
  mint: vi.fn<() => Promise<unknown>>(),
  browser: vi.fn<(os: string, url: string) => Promise<unknown>>(),
  messages: [] as string[],
  destinations: [] as string[],
  listeners: new Set<(state: string) => void>(),
}));
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const roots: ReactTestRenderer[] = [];
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platform;
    },
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));
vi.mock('sonner-native', () => ({
  toast: { error: (message: string) => mocks.messages.push(message) },
}));
vi.mock(import('@tanstack/react-query'), async importOriginal => ({
  ...(await importOriginal()),
  useQueryClient: () => client,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: mocks.userId }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: async (os: string, url: string) => {
    mocks.destinations.push(url);
    const trigger = await mocks.browser(os, url);
    return trigger ?? (mocks.platform === 'ios' ? 'sheet-close' : 'app-foreground');
  },
}));
vi.mock('@/lib/trpc', () => {
  const cloudAgentNext = {
    listGitHubRepositories: {
      queryOptions: (input: unknown) => ({
        queryKey: [['github'], { input, type: 'query' }],
        queryFn: mocks.fetch,
      }),
      queryKey: (input: unknown) => [['github'], { input, type: 'query' }],
    },
  };
  const trpc = { cloudAgentNext, organizations: { cloudAgentNext } };
  return {
    useTRPC: () => trpc,
    trpcClient: { githubApps: { mintInstallState: { mutate: mocks.mint } } },
  };
});
const available = { integrationInstalled: true, repositories: [] };
function discoveryKey(
  organizationId: string,
  forceRefresh = false,
  accountId = mocks.userId
): TRPCQueryKey {
  return [['github'], { input: { organizationId, forceRefresh }, type: 'query', accountId }];
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.userId = 'user-1';
  mocks.platform = 'ios';
  mocks.messages.length = 0;
  mocks.destinations.length = 0;
  mocks.fetch.mockResolvedValue(available);
  mocks.mint.mockResolvedValue({ token: 'install-state' });
  mocks.browser.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  client.clear();
  vi.unstubAllGlobals();
});
async function foreground() {
  await act(() => {
    for (const listener of mocks.listeners) {
      listener('active');
    }
  });
}
function mountRefresh(organizationId: string | undefined = 'org-1') {
  let result: ReturnType<typeof useGitHubReposRefresh> | undefined = undefined;
  function Harness({ org, installed }: { org: string | undefined; installed?: boolean }) {
    result = useGitHubReposRefresh({ organizationId: org, integrationInstalled: installed });
    return null;
  }
  let root: ReactTestRenderer | undefined = undefined;
  act(() => {
    root = TestRenderer.create(React.createElement(Harness, { org: organizationId }));
    roots.push(root);
  });
  return {
    get current() {
      if (!result) {
        throw new Error('Hook did not render');
      }
      return result;
    },
    update: (org: string | undefined, installed?: boolean) =>
      act(() => {
        root?.update(React.createElement(Harness, { org, installed }));
      }),
    unmount: () =>
      act(() => {
        root?.unmount();
      }),
  };
}

describe('legacy refresh decisions', () => {
  it.each([
    ['ios', 'sheet-close'],
    ['android', 'app-foreground'],
    ['web', 'app-foreground'],
    ['', 'app-foreground'],
  ])('uses %s return behavior', (platform, trigger) => {
    expect(resolveRefreshTrigger(platform)).toBe(trigger);
  });
  it.each<[boolean, boolean | undefined, [boolean, boolean]]>([
    [true, false, [true, false]],
    [true, true, [false, true]],
    [true, undefined, [false, false]],
    [false, false, [false, false]],
    [false, true, [false, true]],
    [false, undefined, [false, false]],
  ])('resolves return=%s installed=%s', (isReturnTriggered, integrationInstalled, [set, clear]) => {
    expect(shouldSetConnectCheckFailed({ isReturnTriggered, integrationInstalled })).toBe(set);
    expect(shouldClearConnectCheckFailed({ integrationInstalled })).toBe(clear);
  });
});

it.each(
  ['owner', 'account', 'unmount'].flatMap(change =>
    ['manual', 'connect'].flatMap(mode =>
      ['success', 'failure'].map(outcome => ({ change, mode, outcome }))
    )
  )
)(
  'isolates late $mode refresh $outcome after $change replacement',
  async ({ change, mode, outcome }) => {
    const old = Promise.withResolvers<unknown>();
    mocks.fetch.mockReturnValue(old.promise);
    const hook = mountRefresh();
    const oldRefresh = hook.current.refreshReposForceFresh;
    const requests: Partial<Record<'old' | 'next', Promise<void>>> = {};
    await act(() => {
      if (mode === 'manual') {
        requests.old = oldRefresh();
      } else {
        hook.current.openGitHubIntegration();
      }
    });
    expect(hook.current.isRefreshingRepos).toBe(true);
    const org = change === 'owner' ? 'org-2' : 'org-1';
    if (change === 'account') {
      mocks.userId = 'user-2';
    }
    if (change === 'unmount') {
      hook.unmount();
    } else {
      hook.update(org);
    }
    const replacement = Promise.withResolvers<unknown>();
    mocks.fetch.mockReturnValue(replacement.promise);
    if (change !== 'unmount') {
      expect(hook.current.isRefreshingRepos).toBe(false);
      act(() => {
        requests.next = hook.current.refreshReposForceFresh();
      });
    }
    await act(async () => {
      if (outcome === 'success') {
        old.resolve({ integrationInstalled: false, repositories: ['old'] });
      } else {
        old.reject(new Error('Retired request failed'));
      }
      await requests.old;
      await oldRefresh();
    });
    expect(client.getQueryData(discoveryKey('org-1', false, 'user-1'))).toBeUndefined();
    expect(client.getQueryData(discoveryKey('org-1', true, 'user-1'))).toBeUndefined();
    expect(mocks.messages).toEqual([]);
    if (change !== 'unmount') {
      expect(hook.current.isRefreshingRepos).toBe(true);
      expect(hook.current.connectCheckFailed).toBe(false);
      await act(async () => {
        replacement.resolve(available);
        await requests.next;
      });
      expect(client.getQueryData(discoveryKey(org))).toEqual(available);
      expect(hook.current.isRefreshingRepos).toBe(false);
    }
  }
);

it.each(
  ['owner', 'account', 'unmount'].flatMap(change =>
    ['mint', 'browser'].flatMap(stage =>
      ['success', 'failure'].flatMap(outcome =>
        ['ios', 'android'].map(os => ({ change, stage, outcome, os }))
      )
    )
  )
)(
  'ignores late $stage $outcome after $change replacement on $os',
  async ({ change, stage, outcome, os }) => {
    mocks.platform = os;
    const old = Promise.withResolvers<unknown>();
    if (stage === 'mint') {
      mocks.mint.mockReturnValue(old.promise);
    } else {
      mocks.browser.mockReturnValue(old.promise);
    }
    const hook = mountRefresh();
    await act(() => {
      hook.current.openGitHubIntegration();
    });
    if (change === 'account') {
      mocks.userId = 'user-2';
    }
    if (change === 'unmount') {
      hook.unmount();
    } else {
      hook.update(change === 'owner' ? 'org-2' : 'org-1');
    }
    await act(() => {
      if (outcome === 'failure') {
        old.reject(new Error('Retired browser failed'));
      } else {
        old.resolve(stage === 'mint' ? { token: 'old-state' } : undefined);
      }
    });
    await foreground();
    expect(mocks.destinations).toHaveLength(stage === 'mint' ? 0 : 1);
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(mocks.messages).toEqual([]);
  }
);

it.each(['ios', 'android'])(
  'preserves the %s connection check and consumes each return once',
  async platform => {
    mocks.platform = platform;
    mocks.fetch.mockResolvedValue({ integrationInstalled: false, repositories: [] });
    const hook = mountRefresh();
    await act(() => {
      hook.current.openGitHubIntegration();
    });
    await foreground();
    expect(hook.current.connectCheckFailed).toBe(true);
    const key = discoveryKey('org-1');
    client.setQueryData(key, { ...available, repositories: ['newer rows'] });
    await foreground();
    expect(client.getQueryData(key)).toMatchObject({ repositories: ['newer rows'] });
    hook.update('org-1', true);
    expect(hook.current.connectCheckFailed).toBe(false);
    mocks.fetch.mockRejectedValue(new Error('Offline'));
    await act(async () => {
      await hook.current.refreshReposForceFresh();
    });
    expect(mocks.messages).toEqual(['Could not refresh repositories. Please try again.']);
    expect(client.getQueryData(key)).toMatchObject({ repositories: ['newer rows'] });
    expect(hook.current.isRefreshingRepos).toBe(false);
  }
);
