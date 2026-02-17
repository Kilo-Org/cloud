import type { ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createTRPCContext } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';

/**
 * Server component that prefetches the organizations list during SSR,
 * so the OrganizationSwitcher renders immediately without a loading skeleton.
 *
 * Uses tRPC's createTRPCOptionsProxy to generate the correct query key,
 * matching what the client-side `trpc.organizations.list.queryOptions()` produces.
 */
export async function PrefetchedOrganizations({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();

  try {
    const ctx = await createTRPCContext();
    const trpc = createTRPCOptionsProxy({ router: rootRouter, ctx, queryClient });
    await queryClient.prefetchQuery(trpc.organizations.list.queryOptions());
  } catch (error) {
    // Prefetch failures are non-fatal — the client-side query will handle fetching.
    // Still report to Sentry so real server failures don't go unnoticed.
    Sentry.captureException(error);
  }

  return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
}
