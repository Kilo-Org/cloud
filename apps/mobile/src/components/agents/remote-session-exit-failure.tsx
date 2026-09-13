import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type RemoteSessionExitFailureProps = {
  /** Localized copy for the failed exit. */
  message: string;
  /** Re-runs the exit mutation without another confirmation. */
  onRetry: () => void;
  /** Hides the spinner-free state while the retry is in flight. */
  isRetrying: boolean;
};

/**
 * Durable retry surface for a retryable remote-session exit failure.
 *
 * A transient toast cannot carry this retry: the transport is down, so the
 * reader must restore connectivity before trying again, and by then the toast
 * is gone (and it was never exposed to assistive technology). This row stays
 * until the retry succeeds or the screen is left, and its button is a real
 * accessibility node the device flows can assert and tap.
 */
export function RemoteSessionExitFailure({
  message,
  onRetry,
  isRetrying,
}: Readonly<RemoteSessionExitFailureProps>) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 border-t border-border bg-secondary px-4 py-3">
      <AccessibleStatus message={message} tone="error" className="text-center text-sm" />
      <Button
        variant="outline"
        size="sm"
        loading={isRetrying}
        accessibilityLabel={t('common.tryAgain')}
        onPress={onRetry}
      >
        <Text>{t('common.tryAgain')}</Text>
      </Button>
    </View>
  );
}
