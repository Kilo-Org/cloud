import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type NewSessionStartButtonProps = {
  isCloneEntry: boolean;
  isRemote: boolean;
  isStartDisabled: boolean;
  isStarting: boolean;
  /** One line naming why Start is unavailable (missing repository), or null. */
  startBlockedReason?: string | null;
  onStartSession: () => void;
};

/**
 * The new-session Start submit button. Every branch keeps a visible busy label
 * while starting: import for a live CLI, clone for Cloud Agent, and
 * `common.starting` for the ordinary form. All branches pass `loading` so the
 * busy state keeps the brand fill instead of the muted disabled fill, and the
 * Button's inline spinner sits beside the label.
 *
 * A `startBlockedReason` renders directly above Start through the shared
 * `AccessibleStatus`, so a disabled Start is never a silent dead end: the text
 * is announced (Android polite live region, iOS imperative announce) exactly
 * when it appears.
 */
export function NewSessionStartButton({
  isCloneEntry,
  isRemote,
  isStartDisabled,
  isStarting,
  startBlockedReason = null,
  onStartSession,
}: Readonly<NewSessionStartButtonProps>) {
  const { t } = useTranslation();

  const reason = (
    <AccessibleStatus message={startBlockedReason} tone="status" className="mt-6 text-sm" />
  );

  if (isCloneEntry) {
    let label = t('agentChat.newSession.startSession');
    if (isStarting) {
      label = isRemote
        ? t('agentChat.newSession.importingSession')
        : t('agentChat.session.cloningSession');
    }
    return (
      <>
        {reason}
        <Button
          size="lg"
          className="mt-6"
          disabled={isStartDisabled}
          loading={isStarting}
          onPress={onStartSession}
        >
          <Text>{label}</Text>
        </Button>
      </>
    );
  }

  return (
    <>
      {reason}
      <Button
        size="lg"
        className="mt-6"
        disabled={isStartDisabled}
        loading={isStarting}
        onPress={onStartSession}
      >
        <Text>{isStarting ? t('common.starting') : t('agentChat.newSession.startSession')}</Text>
      </Button>
    </>
  );
}
