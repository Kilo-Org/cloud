import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';
import { PR_REVIEW_ENTRY_HREF } from '@/lib/pr-review/pr-review-entry';

/**
 * Header for every PR-review connect-gate state.
 *
 * A cold deep link renders the gate on top of the tab anchor, so
 * `router.canGoBack()` is true and a plain Back would pop out of PR review to
 * Home. Dismissing to the inbox pops back to it when the user arrived from
 * there, and replaces the gate with it otherwise.
 */
export function PrReviewGateHeader() {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <ScreenHeader
      title={t('common.prReview')}
      showBackButton
      onBack={() => {
        router.dismissTo(PR_REVIEW_ENTRY_HREF);
      }}
    />
  );
}
