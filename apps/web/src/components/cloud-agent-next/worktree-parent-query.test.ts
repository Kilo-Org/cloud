import { QueryClient, skipToken } from '@tanstack/react-query';
import { createTRPCClient } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { RootRouter } from '@/routers/root-router';
import { worktreeParentQueryOptions } from './worktree-parent-query';

const worktreeId = 'worktree_12345678-1234-4234-9234-123456789abc';
const parent = { session_id: 'ses_parent', title: 'Parent workspace', organization_id: null };

function fixture() {
  const requests: { path: string; input: unknown }[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const client = createTRPCClient<RootRouter>({
    links: [
      () =>
        ({ op }) =>
          observable(observer => {
            requests.push({ path: op.path, input: op.input });
            observer.next({ result: { data: parent } });
            observer.complete();
          }),
    ],
  });
  const trpc = createTRPCOptionsProxy<RootRouter>({ client, queryClient });
  const options = (userId = 'owner', organizationId: string | null = null) =>
    worktreeParentQueryOptions({ trpc, client, userId, organizationId, worktreeId });
  return { queryClient, client, trpc, requests, options };
}

describe('worktree parent query transport and cache', () => {
  it('calls the real tRPC procedure without putting the cache owner in its path or input', async () => {
    const { queryClient, requests, options } = fixture();
    try {
      expect(await queryClient.fetchQuery(options('oauth/github|owner'))).toEqual(parent);
      expect(requests).toEqual([
        {
          path: 'cliSessionsV2.worktreeParent',
          input: { worktreeId, organizationId: null },
        },
      ]);
    } finally {
      queryClient.clear();
    }
  });

  it('reuses sibling lookups while separating account and organization caches', async () => {
    const { queryClient, requests, options } = fixture();
    try {
      await queryClient.fetchQuery(options());
      await queryClient.fetchQuery(options());
      expect(requests).toHaveLength(1);

      await queryClient.fetchQuery(options('other-owner'));
      await queryClient.fetchQuery(options('owner', '9a283302-b75d-4375-a1ba-e319a02e18b7'));
      expect(requests).toHaveLength(3);
      expect(requests.every(request => request.path === 'cliSessionsV2.worktreeParent')).toBe(true);
    } finally {
      queryClient.clear();
    }
  });

  it('preserves tRPC path invalidation for every user-scoped cache entry', async () => {
    const { queryClient, trpc, options } = fixture();
    try {
      await queryClient.fetchQuery(options());
      await queryClient.fetchQuery(options('other-owner'));
      await queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeParent.pathFilter());

      expect(queryClient.getQueryState(options().queryKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(options('other-owner').queryKey)?.isInvalidated).toBe(true);
    } finally {
      queryClient.clear();
    }
  });

  it('does not query for a standalone session without a worktree', () => {
    const { queryClient, trpc, client, requests } = fixture();
    try {
      const options = worktreeParentQueryOptions({
        trpc,
        client,
        userId: 'owner',
        organizationId: null,
        worktreeId: null,
      });
      expect(options.queryFn).toBe(skipToken);
      expect(requests).toHaveLength(0);
    } finally {
      queryClient.clear();
    }
  });
});
