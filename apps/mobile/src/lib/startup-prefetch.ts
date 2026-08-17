import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { type MobileRouter } from '@kilocode/trpc/mobile';

import { preloadedAuthToken } from '@/lib/auth/auth-context';
import { queryClient } from '@/lib/query-client';
import { trpcClient } from '@/lib/trpc';

const trpcOptions = createTRPCOptionsProxy<MobileRouter>({ client: trpcClient, queryClient });

// Start the getMe fetch as soon as the stored token is known, instead of after
// the first React render. Same query key as useCurrentUserId — React Query
// dedupes the in-flight fetch when the hook mounts.
//
// 401-before-mount: handleTrpcQueryError no-ops while AuthProvider has not yet
// registered the unauthorized handler. That is acceptable: an errored query has
// no dataUpdatedAt, so the mounted useQuery refetches immediately and the
// error handling then runs exactly as today. Net cost: one extra failed request
// on the already-broken-token path.
export function prefetchCurrentUser(): void {
  void (async () => {
    const token = await preloadedAuthToken;
    if (token != null) {
      await queryClient.prefetchQuery(trpcOptions.user.getMe.queryOptions());
    }
  })();
}
