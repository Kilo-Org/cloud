import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { createCallerFactory, createTRPCContext } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';

const createCaller = createCallerFactory(rootRouter);

/**
 * Server component that prefetches the organizations list on the server,
 * so the OrganizationSwitcher can render immediately without a loading skeleton.
 *
 * The query key must match what tRPC generates for `trpc.organizations.list.queryOptions()`.
 * Verified with @trpc/tanstack-react-query@^11.9.0 — key format: [["organizations", "list"], { type: "query" }]
 * If this breaks after a tRPC upgrade, check the key with `trpc.organizations.list.queryKey()` in a client component.
 */
export async function PrefetchedOrganizations({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient();

  try {
    const ctx = await createTRPCContext();
    const caller = createCaller(ctx);
    const organizations = await caller.organizations.list();
    queryClient.setQueryData([['organizations', 'list'], { type: 'query' }], organizations);
  } catch {
    // If prefetch fails (e.g. user not authenticated), just render children without prefetched data.
    // The client-side query will handle fetching.
  }

  return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
}
