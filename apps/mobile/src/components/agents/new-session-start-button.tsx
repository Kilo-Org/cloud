import { ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type NewSessionStartButtonProps = {
  isCloneEntry: boolean;
  isRemote: boolean;
  isStartDisabled: boolean;
  isStarting: boolean;
  onStartSession: () => void;
};

/**
 * The new-session Start submit button. The Continue form shows a busy label
 * (import for a live CLI, clone for Cloud Agent) and keeps the visible child;
 * the ordinary form swaps in a spinner.
 */
export function NewSessionStartButton({
  isCloneEntry,
  isRemote,
  isStartDisabled,
  isStarting,
  onStartSession,
}: Readonly<NewSessionStartButtonProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  if (isCloneEntry) {
    let label = t('agentChat.newSession.startSession');
    if (isStarting) {
      label = isRemote
        ? t('agentChat.newSession.importingSession')
        : t('agentChat.session.cloningSession');
    }
    return (
      <Button
        size="lg"
        className="mt-6"
        disabled={isStartDisabled}
        loading={isStarting}
        onPress={onStartSession}
      >
        <Text>{label}</Text>
      </Button>
    );
  }

  return (
    <Button size="lg" className="mt-6" disabled={isStartDisabled} onPress={onStartSession}>
      {isStarting ? (
        <ActivityIndicator size="small" color={colors.primaryForeground} />
      ) : (
        <Text>{t('agentChat.newSession.startSession')}</Text>
      )}
    </Button>
  );
}
