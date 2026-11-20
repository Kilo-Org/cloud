import { type MobileRouter } from '@kilocode/trpc/mobile';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import {
  applyForceStatePath,
  getForcedMode,
  isForcedOffline,
  isForceStateHoldingReadCache,
  resetForceStateForTests,
  withForceState,
} from '@/lib/force-state-fixture';
import { createKiloAppQueryClient } from '@/lib/query-client';
import {
  isPermissionDeniedError,
  isRetryableTrpcError,
  readTrpcErrorField,
  trpcErrorVariant,
} from '@/lib/trpc-error';

const TRPC_URL = 'https://force-state.test/api/trpc';
const ME = { id: 'user-1', email: 'fake@example.test' };

const transport = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let client = new QueryClient();

function trpc() {
  return createTRPCClient<MobileRouter>({
    links: [httpLink({ url: TRPC_URL, fetch: withForceState(transport), methodOverride: 'POST' })],
  });
}

function force(link: string) {
  return applyForceStatePath(link, client);
}

async function failure(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('the call did not fail');
}

beforeEach(() => {
  resetForceStateForTests();
  client = new QueryClient();
  transport
    .mockReset()
    .mockImplementation(() => Promise.resolve(Response.json({ result: { data: ME } })));
});

afterEach(() => {
  resetForceStateForTests();
  client.clear();
});

describe('force-state links', () => {
  it('ignores a link that is not a force-state link', () => {
    expect(force('kiloapp:///(app)/(tabs)/(2_agents)')).toBeUndefined();
    expect(getForcedMode()).toBeNull();
  });

  it('forces the mode and hands back the decoded next link', () => {
    const next = encodeURIComponent('kiloapp:///(app)/code-reviewer/personal/reviews');
    expect(force(`kiloapp:///dev/force-state/permission?next=${next}`)).toBe(
      'kiloapp:///(app)/code-reviewer/personal/reviews'
    );
    expect(getForcedMode()).toBe('permission');
  });

  it('accepts the scheme-less path expo-router hands over, and no next link', () => {
    expect(force('/dev/force-state/loading')).toBeNull();
    expect(getForcedMode()).toBe('loading');
  });

  it('leaves the state alone for an unknown mode', () => {
    expect(force('kiloapp:///dev/force-state/broken?next=%2F(app)')).toBeNull();
    expect(getForcedMode()).toBeNull();
    expect(isForceStateHoldingReadCache()).toBe(false);
  });

  it('clears to Home, or to the next link', () => {
    force('kiloapp:///dev/force-state/offline');
    expect(force('kiloapp:///dev/force-state/clear')).toBe('/(app)/(tabs)/(0_home)');
    expect(getForcedMode()).toBeNull();
    expect(isForcedOffline()).toBe(false);
    expect(force('kiloapp:///dev/force-state/clear?next=%2F(app)%2Fusage')).toBe('/(app)/usage');
  });

  it('holds the read cache from the first forced mode, also after clear', () => {
    expect(isForceStateHoldingReadCache()).toBe(false);
    force('kiloapp:///dev/force-state/retryable');
    expect(isForceStateHoldingReadCache()).toBe(true);
    force('kiloapp:///dev/force-state/clear');
    expect(isForceStateHoldingReadCache()).toBe(true);
  });

  it('resets cached tRPC reads, but keeps the bootstrap reads and app keys', () => {
    const reviewsKey = [['codeReviews', 'listForUser'], { type: 'infinite' }];
    const meKey = [['user', 'getMe'], { type: 'query' }];
    const orgsKey = [['organizations', 'list'], { type: 'query' }];
    const appKey = ['org-default-model', 'org-1'];
    client.setQueryData(reviewsKey, { pages: [], pageParams: [] });
    client.setQueryData(meKey, ME);
    client.setQueryData(orgsKey, []);
    client.setQueryData(appKey, 'model');

    force('kiloapp:///dev/force-state/loading');

    expect(client.getQueryData(reviewsKey)).toBeUndefined();
    expect(client.getQueryData(meKey)).toEqual(ME);
    expect(client.getQueryData(orgsKey)).toEqual([]);
    expect(client.getQueryData(appKey)).toBe('model');
  });
});

describe('forced answers through the real tRPC link', () => {
  it.each([
    {
      mode: 'retryable',
      code: 'INTERNAL_SERVER_ERROR',
      variant: 'server',
      retryable: true,
      permissionLoss: false,
    },
    {
      mode: 'non-retryable',
      code: 'NOT_FOUND',
      variant: 'not-found',
      retryable: false,
      permissionLoss: false,
    },
    {
      mode: 'permission',
      code: 'FORBIDDEN',
      variant: 'permission',
      retryable: false,
      permissionLoss: true,
    },
  ] as const)(
    '$mode answers $code: the $variant variant, retryable=$retryable, permission loss=$permissionLoss',
    async ({ mode, code, variant, retryable, permissionLoss }) => {
      force(`kiloapp:///dev/force-state/${mode}`);

      const error = await failure(trpc().codeReviews.listForUser.query({ limit: 50, offset: 0 }));

      expect(error).toBeInstanceOf(TRPCClientError);
      expect(readTrpcErrorField(error, 'code')).toBe(code);
      expect(trpcErrorVariant(error)).toBe(variant);
      expect(isRetryableTrpcError(error)).toBe(retryable);
      expect(isPermissionDeniedError(error)).toBe(permissionLoss);
      expect(transport).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['retryable', true],
    ['non-retryable', false],
    ['permission', false],
  ] as const)('the app query client retries %s: %s', async (mode, retries) => {
    force(`kiloapp:///dev/force-state/${mode}`);
    const error = await failure(trpc().codeReviews.listForUser.query({ limit: 50, offset: 0 }));
    const retry = createKiloAppQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') {
      throw new TypeError('the app query client has no retry policy');
    }

    expect(retry(0, error)).toBe(retries);
  });

  it.each(['retryable', 'non-retryable', 'permission', 'offline'] as const)(
    'never signs the user out on a forced %s failure',
    async mode => {
      const signOut = vi.fn();
      const restore = setTrpcUnauthorizedHandler(signOut);
      const appClient = createKiloAppQueryClient();
      try {
        applyForceStatePath(`kiloapp:///dev/force-state/${mode}`, appClient);
        await failure(
          appClient.fetchQuery({
            queryKey: ['forced', mode],
            queryFn: () => trpc().codeReviews.listForUser.query({ limit: 50, offset: 0 }),
            retry: false,
            networkMode: 'always',
          })
        );
      } finally {
        restore();
        appClient.clear();
      }

      expect(signOut).not.toHaveBeenCalled();
    }
  );

  it('fails a mutation in the mode too, so nothing is written', async () => {
    force('kiloapp:///dev/force-state/permission');

    const error = await failure(trpc().moderation.unblockUser.mutate({ githubLogin: 'octocat' }));

    expect(trpcErrorVariant(error)).toBe('permission');
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails offline the way React Native fetch does without a network', async () => {
    force('kiloapp:///dev/force-state/offline');

    const error = await failure(trpc().codeReviews.listForUser.query({ limit: 50, offset: 0 }));

    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error.cause).toEqual(new TypeError('Network request failed'));
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps a loading request in flight until clear, then asks the backend', async () => {
    vi.useFakeTimers();
    try {
      force('kiloapp:///dev/force-state/loading');
      let answer: unknown = 'pending';
      const call = (async () => {
        answer = await trpc().user.getPasskeys.query();
      })();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(answer).toBe('pending');
      expect(transport).not.toHaveBeenCalled();

      force('kiloapp:///dev/force-state/clear');
      await call;

      expect(transport).toHaveBeenCalledOnce();
      expect(answer).toEqual(ME);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a loading request into the next forced mode', async () => {
    vi.useFakeTimers();
    try {
      force('kiloapp:///dev/force-state/loading');
      const call = failure(trpc().user.getPasskeys.query());
      await vi.advanceTimersByTimeAsync(1000);

      force('kiloapp:///dev/force-state/non-retryable');

      expect(trpcErrorVariant(await call)).toBe('not-found');
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['loading', 'retryable', 'non-retryable', 'permission', 'offline'] as const)(
    'answers the auth bootstrap read live while %s holds',
    async mode => {
      force(`kiloapp:///dev/force-state/${mode}`);

      await expect(trpc().user.getMe.query()).resolves.toEqual(ME);
      expect(transport).toHaveBeenCalledOnce();
    }
  );

  it('passes every request through while no mode was forced', async () => {
    await expect(trpc().codeReviews.listForUser.query({ limit: 50, offset: 0 })).resolves.toEqual(
      ME
    );
    force('kiloapp:///dev/force-state/retryable');
    force('kiloapp:///dev/force-state/clear');
    await expect(trpc().codeReviews.listForUser.query({ limit: 50, offset: 0 })).resolves.toEqual(
      ME
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('passes a batched call through while a mode holds', async () => {
    force('kiloapp:///dev/force-state/permission');
    const url = `${TRPC_URL}/codeReviews.listForUser?batch=1`;

    const response = await withForceState(transport)(url, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledExactlyOnceWith(url, { method: 'POST' });
  });
});
