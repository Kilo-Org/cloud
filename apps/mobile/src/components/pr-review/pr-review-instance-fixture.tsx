import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';

/**
 * Development-only entry for the connect gate's GitLab-instance state.
 *
 * It opens the same route the paste flow opens — a provider merge request with
 * the pasted URL's `?instance=` hint — through the same `router.replace` the
 * entry screen calls. A system link cannot stand in for it: the app's resolver
 * drops a link's query before the route reads it, so only an in-app navigation
 * carries the hint. Reached with
 * `kiloapp:///dev/pr-review-gitlab-instance-fixture`.
 */

/** A self-managed instance, which no gitlab.com connection can serve. */
const FIXTURE_REF = {
  platform: 'gitlab',
  projectPath: 'sample/platform/engineering/a-repository-with-a-long-name',
  mrIid: 18,
  instanceHint: 'https://gitlab.example.com',
} as const;

export function PrReviewGitlabInstanceFixture() {
  const router = useRouter();
  const colors = useThemeColors();

  useEffect(() => {
    router.replace(providerPrRoutePath(FIXTURE_REF));
  }, [router]);

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <CenteredState>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </CenteredState>
    </View>
  );
}
