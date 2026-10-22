import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type RemoteSpawnFailure } from '@/components/agents/use-remote-spawn-dispatch';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type NewSessionRemoteSpawnFailureProps = {
  failure: RemoteSpawnFailure;
  /** Re-runs the spawn with the same draft (the retryable recovery). */
  onRetry?: () => void;
  /** The Start gate, inherited so a retry is never offered while Start itself is blocked. */
  isRetryDisabled: boolean;
};

/**
 * Persistent failure feedback for a remote spawn, rendered in the reserved
 * spot above Start (the cloud-create slot's remote-target mirror). A
 * retryable failure carries the retry control; a terminal one says what the
 * server or transport reported instead. The form owns this feedback, so the
 * spawn dispatch renders no toast beside it.
 */
export function NewSessionRemoteSpawnFailure({
  failure,
  onRetry,
  isRetryDisabled,
}: Readonly<NewSessionRemoteSpawnFailureProps>) {
  const { t } = useTranslation();
  return (
    <View className="mt-5 gap-2">
      <AccessibleStatus message={failure.message} tone="error" className="text-sm" />
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
