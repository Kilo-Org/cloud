import { type Href, Stack, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrReviewScreen } from '@/components/pr-review/pr-review-screen';
import { parseProviderPrRoute, providerPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { parseParam } from '@/lib/route-params';

type Params = {
  platform: string;
  identity: string[];
  instance?: string;
};

/**
 * The provider PR/MR detail screen. The layout above already validated the
 * route and published the scope, so the screen renders through the same tree
 * GitHub uses; the triple it takes is the GitHub-shaped identity its stores
 * are keyed on, while its queries follow the ref from the scope.
 */
export default function ProviderPrReviewIndexRoute() {
  const params = useLocalSearchParams<Params>();
  const ref = parseProviderPrRoute({
    platform: parseParam(params.platform) ?? '',
    identity: params.identity,
    instance: params.instance,
  });

  if (!ref) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  const { owner, repo, number } = providerPrTriple(ref);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PrReviewScreen owner={owner} repo={repo} number={number} />
    </>
  );
}
