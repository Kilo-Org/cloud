import { type Href, Stack } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { useValidatedReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

// Single validation point for the `scope`+`platform` params — every route
// under `[platform]/` is a descendant of this layout, so rejecting an
// invalid combination here blocks all of them before any query/mutation
// runs. Mirrors security-agent's `[scope]/_layout.tsx`.
export default function CodeReviewerPlatformLayout() {
  const params = useValidatedReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/code-reviewer' as Href} />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
