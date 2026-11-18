import { createElement } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { useActiveSessions } from '@/lib/active-sessions-query';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';
import { act } from '@/test/renderer';

const state = vi.hoisted(() => ({
  auth: {
    token: 'account' as string | undefined,
    isLoading: false,
    isSigningOut: false,
    authEpoch: 0,
  },
  organization: { organizationId: null as string | null, isLoaded: true },
  request: vi.fn<() => Promise<CachedActiveSessionsData>>(),
  queryOptions:
    vi.fn<(input: unknown, options: Record<string, unknown>) => Record<string, unknown>>(),
}));

vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => state.organization }));

function key(input: unknown) {
  return [['activeSessions', 'list'], { input, type: 'query' }];
}

vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: key,
        queryOptions: (input: unknown, options: Record<string, unknown>) =>
          state.queryOptions(input, options),
      },
    },
  };
  return { useTRPC: () => trpc };
});

function Probe() {
  useActiveSessions();
  return null;
}

async function advanceBy(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setSignOutActive(false);
  onlineManager.setOnline(true);
  Object.assign(state.auth, {
    token: 'account',
    isLoading: false,
    isSigningOut: false,
    authEpoch: currentAuthEpoch(),
  });
  Object.assign(state.organization, { organizationId: null, isLoaded: true });
  state.request.mockReset().mockResolvedValue({ sessions: [] });
  state.queryOptions.mockReset().mockImplementation((input, options) => ({
    queryKey: key(input),
    queryFn: state.request,
    ...options,
  }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  setSignOutActive(false);
  onlineManager.setOnline(true);
});

describe('useActiveSessions poll ownership', () => {
  it('configures the query without a React Query interval and fetches only once', async () => {
    const rendered = await renderWithProviders(createElement(Probe), {
      queryClient: createTestQueryClient(),
    });
    await advanceBy(0);
    expect(state.request).toHaveBeenCalledTimes(1);

    expect(state.queryOptions).toHaveBeenCalled();
    const optionArgs = state.queryOptions.mock.calls.map(call => call[1]);
    expect(optionArgs.every(options => options.refetchInterval === false)).toBe(true);

    // The report's A/B 2 condition: with the interval gone, a 60s window holds
    // no further fetch (the floor poll owns polling on live surfaces).
    await advanceBy(60_000);
    expect(state.request).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});
