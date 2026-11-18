// Persistent partial-success banner surfaced on the PR review screen
// after a merge whose branch-delete step failed. The merge itself
// SUCCEEDED — this banner is informational only and intentionally has
// NO destructive CTA (the user already merged; re-running the merge
// would 422 and there is no rollback from the client side).
//
// Styling keeps the full accent surface: this banner lands after the merge, so
// no primary action shares the screen and it is the one element that reports
// the outcome. `AutoMergeEnabledBanner` sits directly above the merge button,
// so it paints the low-emphasis accent tint instead.

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

export function PrMergePartialSuccessBanner({ reason }: Readonly<{ reason: string }>) {
  const { t } = useTranslation();
  return (
    <View
      className="gap-1 rounded-lg bg-accent-soft p-4"
      accessibilityLabel={t('prReview.merge.partialSuccessBanner.accessibility', { reason })}
    >
      <Text className="text-sm font-medium text-accent-soft-foreground">
        {t('prReview.overview.stateMerged')}
      </Text>
      <Text className="text-xs text-accent-soft-foreground">
        {t('prReview.merge.partialSuccessBanner.body', { reason })}
      </Text>
    </View>
  );
}
