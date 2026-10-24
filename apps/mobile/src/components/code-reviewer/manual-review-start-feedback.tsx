import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type ManualReviewStartFeedbackProps = {
  /** The watchdog fired: the start has not settled within its budget. */
  stalled: boolean;
  /** The settled failure message from the mutation, or null. */
  startError: string | null;
  /** Re-runs the start with the same draft (the recovery control). */
  onRetry: () => void;
};

/**
 * Failure feedback for the manual-review start, pinned with the action in the
 * screen's footer so the recovery control is visible with the keyboard up too.
 * The watchdog stall says the wait exceeded the budget; a settled failure says
 * what the server or transport reported. Both clear on the next submit. The
 * a11y announcement rides the inline `AccessibleStatus` (the screen renders
 * the failure, so no toast fires beside it).
 */
export function ManualReviewStartFeedback({
  stalled,
  startError,
  onRetry,
}: Readonly<ManualReviewStartFeedbackProps>) {
  const { t } = useTranslation();
  const message = stalled ? t('common.takingLonger') : startError;
  if (message === null) {
    return null;
  }
  return (
    <View className="gap-2 pb-3">
      <AccessibleStatus message={message} tone="error" className="text-sm" />
      <Button variant="outline" onPress={onRetry} accessibilityLabel={t('common.retry')}>
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
