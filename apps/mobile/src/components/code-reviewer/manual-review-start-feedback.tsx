import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

import { type WatchedStartFailure } from './deadline-watched-start';

type ManualReviewStartFeedbackProps = {
  /** The watchdog fired: the start has not settled within its budget. */
  stalled: boolean;
  /** The settled failure from the mutation, or null. */
  failure: WatchedStartFailure | null;
  /** Re-runs the start with the same draft (the recovery control). */
  onRetry: () => void;
};

/**
 * Failure feedback for the manual-review start, pinned with the action in the
 * screen's footer so the recovery control is visible with the keyboard up too.
 * The watchdog stall says the wait exceeded the budget; a settled failure says
 * what the server or transport reported. Both describe the input that produced
 * them, so they clear when that input changes or on the next submit. The a11y
 * announcement rides the inline `AccessibleStatus` (the screen renders the
 * failure, so no toast fires beside it).
 *
 * The retry is offered only when resending can change the outcome: a stall
 * always can, while a terminal refusal (a lapsed organization plan, a lost
 * role) can only be fixed elsewhere, so the pinned action stays as the single
 * way forward instead of two controls that do the same thing.
 */
export function ManualReviewStartFeedback({
  stalled,
  failure,
  onRetry,
}: Readonly<ManualReviewStartFeedbackProps>) {
  const { t } = useTranslation();
  const message = stalled ? t('common.takingLonger') : (failure?.message ?? null);
  if (message === null) {
    return null;
  }
  const retryable = stalled || failure?.retryable === true;
  return (
    <View className="gap-2 pb-3">
      <AccessibleStatus message={message} tone="error" className="text-sm" />
      {retryable ? (
        <Button variant="outline" onPress={onRetry} accessibilityLabel={t('common.retry')}>
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
