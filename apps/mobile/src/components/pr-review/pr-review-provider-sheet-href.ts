// The write-sheet routes inside the provider layout (s6). The comment
// composer, the review-submit sheet and the merge sheet are children of the
// PR's own route on every provider: the provider scope and the
// `PendingReviewProvider` queue are published by the provider layout, so a
// provider sheet must be reached through the provider route — pushing the
// GitHub sibling would leave that scope and write to the wrong provider. The
// GitHub route keeps its own literal paths untouched.
import { type Href } from 'expo-router';

import { type ProviderPrRef, providerPrRouteSegments } from '@/lib/pr-review/provider-pr-ref';

export type ProviderPrSheetRoute = 'comment-composer' | 'review-submit' | 'merge';

/**
 * The href for one sheet under the ref's own route. A GitLab `instanceHint`
 * rides as the `instance` query param — the same param the provider layout
 * reads for the base route — so the sheet stays on the instance the reader
 * opened. Extra params (composer position, merge mode) ride as query params.
 */
export function providerPrSheetHref(
  ref: ProviderPrRef,
  sheet: ProviderPrSheetRoute,
  params: Record<string, string | number> = {}
): Href {
  const { platform, identity } = providerPrRouteSegments(ref);
  const encoded = identity.map(segment => encodeURIComponent(segment)).join('/');
  const instance =
    ref.platform === 'gitlab' && ref.instanceHint ? { instance: ref.instanceHint } : {};
  return {
    pathname: `/(app)/pr-review/${platform}/${encoded}/${sheet}`,
    params: { ...instance, ...params },
  };
}
