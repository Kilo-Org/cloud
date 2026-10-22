import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';
import {
  usePrReviewInboxBack,
  usePrReviewInboxHardwareBack,
} from '@/lib/pr-review/pr-review-inbox-back';

/**
 * Header for every PR-review connect-gate state.
 *
 * Back — the header control and Android's hardware/gesture Back — always
 * lands on the PR Review inbox: `dismissTo` pops back to it when the user
 * arrived from there and replaces the gate with it otherwise. A cold deep
 * link renders the gate on top of the tab anchor, so a plain pop would leave
 * PR review for Home.
 */
export function PrReviewGateHeader() {
  const { t } = useTranslation();
  const back = usePrReviewInboxBack();
  usePrReviewInboxHardwareBack();

  return <ScreenHeader title={t('common.prReview')} showBackButton onBack={back} />;
}
