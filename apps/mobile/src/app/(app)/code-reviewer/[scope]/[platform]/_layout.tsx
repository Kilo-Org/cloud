import { type Href, Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { InvalidRouteState } from '@/components/invalid-route-state';
import {
  ReviewerRouteParamsProvider,
  useValidatedReviewerRouteParams,
} from '@/lib/hooks/use-reviewer-route-params';

// Single validation point for the `scope`+`platform` params — every route
// under `[platform]/` is a descendant of this layout, so rejecting an
// invalid combination here blocks all of them before any query/mutation
// runs. Mirrors security-agent's `[scope]/_layout.tsx`.
//
// Validating here does not cover the children on its own: each screen is a
// separate route with its own params, and expo-router seeds a nested
// navigator's initial screen with none. So the accepted pair is also published
// to the screens below through the provider, and they read it instead of their
// own params.
export default function CodeReviewerPlatformLayout() {
  const params = useValidatedReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }

  return (
    <ReviewerRouteParamsProvider params={params}>
      <Stack screenLayout={appSceneLayout} screenOptions={{ headerShown: false }} />
    </ReviewerRouteParamsProvider>
  );
}
