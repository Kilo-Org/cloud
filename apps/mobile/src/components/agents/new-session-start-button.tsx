import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

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
 * the ordinary form swaps in the Button's own busy spinner. Both pass
 * `loading` so the busy state keeps the brand fill instead of the muted
 * disabled fill.
 */
export function NewSessionStartButton({
  isCloneEntry,
  isRemote,
  isStartDisabled,
  isStarting,
  onStartSession,
}: Readonly<NewSessionStartButtonProps>) {
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
    <Button
      size="lg"
      className="mt-6"
      disabled={isStartDisabled}
      loading={isStarting}
      onPress={onStartSession}
    >
      {isStarting ? null : <Text>{t('agentChat.newSession.startSession')}</Text>}
    </Button>
  );
}
