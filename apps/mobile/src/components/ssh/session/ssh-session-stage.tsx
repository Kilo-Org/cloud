import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { RefreshCw, Server } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { closeReasonMessage } from '@/lib/ssh/session/phase-copy';
import { type SshSessionPhase } from '@/lib/ssh/session/types';

type SshSessionStageProps = Readonly<{
  phase: SshSessionPhase;
  /** `user@host:port`, so the wait names what it is waiting for. */
  target: string;
  onRetry: () => void;
  onClose: () => void;
}>;

/**
 * What fills the terminal area while there is no shell to draw: the wait for a
 * connection, and the four endings. A shell that is open renders over this, so
 * this surface only appears when the terminal itself has nothing to show.
 */
export function SshSessionStage({ phase, target, onRetry, onClose }: SshSessionStageProps) {
  const { t } = useTranslation();

  if (phase.kind === 'closed') {
    return (
      <EmptyState
        icon={Server}
        title={t('ssh.session.closedTitle')}
        description={closeReasonMessage(t, phase.reason)}
        action={
          <View className="gap-2 self-stretch px-6">
            {phase.retryable ? (
              <Button
                className={STATE_ACTION_CLASS}
                onPress={onRetry}
              >
                <RefreshCw size={16} color="#FFFFFF" />
                <Text>{t('common.retry')}</Text>
              </Button>
            ) : null}
            <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onClose}>
              <Text>{t('ssh.session.backToHosts')}</Text>
            </Button>
          </View>
        }
      />
    );
  }

  const message =
    phase.kind === 'reconnecting'
      ? t('ssh.session.reconnectingStage', { attempt: phase.attempt, target })
      : t('ssh.session.connectingStage', { target });

  return (
    <View className="flex-1 items-center justify-center gap-3 px-8">
      <ActivityIndicator />
      <Text className="text-center text-sm text-muted-foreground">{message}</Text>
      {phase.kind === 'reconnecting' ? (
        <Text className="text-center text-xs text-muted-foreground">
          {closeReasonMessage(t, phase.reason)}
        </Text>
      ) : null}
    </View>
  );
}
