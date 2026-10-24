import { type Href } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PlatformOverviewScreen } from '@/components/code-reviewer/platform-overview-screen';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

// Reads the `scope`+`platform` pair the `[platform]/_layout.tsx` validated,
// never its own route params: this screen's own params can be absent (the
// nested stack is seeded without them) even while the layout's are valid, and
// indexing platform capabilities with that `undefined` crashed the screen.
export default function CodeReviewerPlatformRoute() {
  const params = useReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }

  return <PlatformOverviewScreen scope={params.scope} platform={params.platform} />;
}
