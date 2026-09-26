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
 * The new-session Start submit button. Every branch keeps a visible busy label
 * while starting: import for a live CLI, clone for Cloud Agent, and
 * `common.starting` for the ordinary form. All branches pass `loading` so the
 * busy state keeps the brand fill instead of the muted disabled fill, and the
 * Button's inline spinner sits beside the label.
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
      <Text>{isStarting ? t('common.starting') : t('agentChat.newSession.startSession')}</Text>
    </Button>
  );
}
