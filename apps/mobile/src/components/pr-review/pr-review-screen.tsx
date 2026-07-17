import { GitPullRequest } from 'lucide-react-native';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type PrReviewScreenProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

// Placeholder for the PR review screen. S5 fleshes this out into the
// Overview / Diff / Discussion / Merge tab surface; S4b only needs the
// route to render *something* so the navigation tree typechecks and the
// gate's happy path can be exercised end-to-end.
export function PrReviewScreen({ owner, repo, number }: PrReviewScreenProps) {
  const colors = useThemeColors();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Pull Request" eyebrow={`${owner}/${repo}#${number}`} />
      <View className="flex-1 items-center justify-center gap-2 px-6">
        <GitPullRequest size={28} color={colors.mutedForeground} />
        <Text variant="muted">PR review is loading…</Text>
      </View>
    </View>
  );
}
