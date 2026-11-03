import { type Href, Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewerEditGuard } from '@/lib/hooks/use-code-reviewer';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

// Groups the config-editing routes (style/gate/focus-areas/repos/
// instructions) that redirect a read-only viewer back to the overview.
// The `(edit)` group doesn't add a URL segment, so routes keep their
// existing paths. Params are validated by `[platform]/_layout.tsx` and read
// from it here: this layout's own route params can be absent even when the
// pair the guard accepted is valid.
export default function CodeReviewerEditLayout() {
  const params = useReviewerRouteParams();

  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }

  return <EditStack scope={params.scope} platform={params.platform} />;
}

function EditStack({ scope, platform }: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  useReviewerEditGuard(scope, platform);

  return <Stack screenLayout={appSceneLayout} screenOptions={{ headerShown: false }} />;
}
