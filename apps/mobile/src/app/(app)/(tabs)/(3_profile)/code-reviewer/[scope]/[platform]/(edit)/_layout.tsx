import { Stack, useLocalSearchParams } from 'expo-router';

import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useReviewerEditGuard } from '@/lib/hooks/use-code-reviewer';

// Groups the config-editing routes (style/gate/focus-areas/repos/
// instructions) that redirect a read-only viewer back to the overview.
// The `(edit)` group doesn't add a URL segment, so routes keep their
// existing paths. Params are already validated by `[platform]/_layout.tsx`.
export default function CodeReviewerEditLayout() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  useReviewerEditGuard(scope, platform);

  return <Stack screenOptions={{ headerShown: false }} />;
}
