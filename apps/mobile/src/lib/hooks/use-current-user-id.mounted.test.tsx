import { createElement } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deferred, flushQueryUpdates as flush } from '@/lib/active-sessions-live-sync.test-helpers';
import { act } from '@/test/renderer';
import {
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';

import { useCurrentUserId } from './use-current-user-id';

type Account = { id: string; email: string };
/** The value the probe records; the fields these cases assert on. */
type CurrentUser = {
  userId: string | undefined;
  email: string | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetchError: boolean;
  isUnreachable: boolean;
  refetch: () => void;
};

const state = vi.hoisted(() => ({
  request: vi.fn<() => Promise<Account>>(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      getMe: {
        queryOptions: () => ({ queryKey: ['user', 'getMe'], queryFn: state.request }),
      },
    },
  }),
}));

let latest: CurrentUser | undefined = undefined;
let tree: RenderWithProvidersResult | undefined = undefined;

/** The hook's value as of the last committed render. */
function Probe(): null {
  latest = useCurrentUserId();
  return null;
}

function current(): CurrentUser {
  if (!latest) {
    throw new Error('Missing hook result');
  }
  return latest;
}

async function render(): Promise<void> {
  tree = await renderWithProviders(createElement(Probe));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onlineManager.setOnline(true);
  state.request.mockReset();
  latest = undefined;
});

afterEach(() => {
  tree?.unmount();
  tree = undefined;
  latest = undefined;
  onlineManager.setOnline(true);
});

describe('useCurrentUserId online manager subscription', () => {
  it('re-renders on the online edge so a cold start resolves the account', async () => {
    onlineManager.setOnline(false);
    const network = deferred<Account>();
    state.request.mockReturnValue(network.promise);

    await render();
    expect(current().isUnreachable).toBe(true);
    // `SETTLE_WHILE_OFFLINE` is `networkMode: 'always'`, so the attempt was
    // issued while the manager reported offline; the case cannot pass by the
    // query having been paused instead of sent.
    expect(state.request).toHaveBeenCalledTimes(1);

    await act(async () => {
      onlineManager.setOnline(true);
      await flush();
    });
    // The manager's edge alone has to re-render the hook: the attempt is still
    // in flight, so nothing about the query changed at this point.
    expect(current().isUnreachable).toBe(false);

    await act(async () => {
      network.resolve({ id: 'user-1', email: 'user@example.com' });
      await flush();
    });
    await waitFor(() => current().userId === 'user-1');
    expect(current().isUnreachable).toBe(false);
  });

  it('holds the account as unreachable through a retryable failure and clears on the next success', async () => {
    state.request
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ id: 'user-1', email: 'user@example.com' });

    await render();
    await waitFor(() => current().isUnreachable);
    expect(current().isUnreachable).toBe(true);

    await act(async () => {
      current().refetch();
      await flush();
    });
    await waitFor(() => current().userId === 'user-1');
    expect(current().isUnreachable).toBe(false);
  });

  it('does not hold when the API refuses the credentials', async () => {
    state.request.mockRejectedValue(
      Object.assign(new Error('denied'), { data: { code: 'UNAUTHORIZED' } })
    );

    await render();
    await waitFor(() => current().isError);
    expect(current().isUnreachable).toBe(false);
  });
});
