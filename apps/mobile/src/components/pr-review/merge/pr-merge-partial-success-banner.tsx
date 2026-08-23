// Persistent partial-success banner surfaced on the PR review screen
// after a merge whose branch-delete step failed. The merge itself
// SUCCEEDED — this banner is informational only and intentionally has
// NO destructive CTA (the user already merged; re-running the merge
// would 422 and there is no rollback from the client side).
//
// Styling mirrors `AutoMergeEnabledBanner` so the two read as
// siblings; tone is "soft" / accent, not destructive.

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
        {t('prReview.merge.partialSuccessBanner.title')}
      </Text>
      <Text className="text-xs text-accent-soft-foreground">
        {t('prReview.merge.partialSuccessBanner.body', { reason })}
      </Text>
    </View>
  );
}
