import type { ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { User } from '@kilocode/db/schema';
import { createTRPCContext } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { SeedUserQuery } from './SeedUserQuery';

/**
 * Server component that prefetches the organizations list during SSR,
 * so the OrganizationSwitcher renders immediately without a loading skeleton.
 *
 * Uses tRPC's createTRPCOptionsProxy to generate the correct query key,
 * matching what the client-side `trpc.organizations.list.queryOptions()` produces.
 *
 * It also hands the resolved user to `SeedUserQuery`, which seeds the `['user']`
 * query the sidebar footer and the customer-source survey read, so both render
 * their final markup during SSR instead of swapping a loading state for real
 * content while React is still hydrating.
 */
export async function PrefetchedOrganizations({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  let user: User | null = null;

  try {
    const ctx = await createTRPCContext();
    // Same user `GET /api/user` returns; `useUser()` fetches that route on the client.
    user = ctx.user;
    const trpc = createTRPCOptionsProxy({ router: rootRouter, ctx, queryClient });
    await queryClient.prefetchQuery(trpc.organizations.list.queryOptions());
  } catch (error) {
    // Prefetch failures are non-fatal — the client-side query will handle fetching.
    // Still report to Sentry so real server failures don't go unnoticed.
    Sentry.captureException(error);
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {user !== null ? <SeedUserQuery user={user} /> : null}
      {children}
    </HydrationBoundary>
  );
}
