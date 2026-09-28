import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type CloudCreateFailure } from '@/components/agents/use-new-session-creator';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type NewSessionCloudCreateErrorProps = {
  failure: CloudCreateFailure;
  /** Re-runs the cloud create with the same draft (the retryable recovery). */
  onRetry?: () => void;
  /** The Start gate, inherited so a retry is never offered while Start itself is blocked. */
  isRetryDisabled: boolean;
};

/**
 * Persistent failure feedback for the cloud create, rendered in the reserved
 * spot above Start. A retryable rejection carries the retry control; a
 * terminal one says what the server reported instead. The form owns this
 * feedback, so the creator hook stays silent for it.
 */
export function NewSessionCloudCreateError({
  failure,
  onRetry,
  isRetryDisabled,
}: Readonly<NewSessionCloudCreateErrorProps>) {
  const { t } = useTranslation();
  return (
    <View className="mt-5 gap-2">
      <AccessibleStatus
        message={t('agentChat.newSession.failedToCreate')}
        tone="error"
        className="text-sm"
      />
      {!failure.retryable && failure.message !== t('agentChat.newSession.failedToCreate') ? (
        <AccessibleStatus message={failure.message} tone="status" className="text-sm" />
      ) : null}
      {failure.retryable ? (
        <Button
          variant="outline"
          onPress={onRetry}
          disabled={isRetryDisabled}
          accessibilityLabel={t('common.retry')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
