import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type NewSessionStartBlockedAction = {
  label: string;
  onPress: () => void;
};

type NewSessionStartButtonProps = {
  isCloneEntry: boolean;
  isRemote: boolean;
  isStartDisabled: boolean;
  isStarting: boolean;
  /** One line naming why Start is unavailable (missing repository), or null. */
  startBlockedReason?: string | null;
  /**
   * The recovery action for the named reason, or null when the form offers
   * none. Rendered as a button between the reason and Start; tapping it must
   * leave the prompt draft on the screen.
   */
  startBlockedAction?: NewSessionStartBlockedAction | null;
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
 * when it appears. When the form also names a recovery action for that reason
 * (`startBlockedAction`), an outline button for it sits between the reason and
 * Start — the connect-a-provider and refresh-repositories reasons are
 * recoverable from the footer without scrolling.
 */
export function NewSessionStartButton({
  isCloneEntry,
  isRemote,
  isStartDisabled,
  isStarting,
  startBlockedReason = null,
  startBlockedAction = null,
  onStartSession,
}: Readonly<NewSessionStartButtonProps>) {
  const { t } = useTranslation();

  const reason = (
    <AccessibleStatus message={startBlockedReason} tone="status" className="mt-6 text-sm" />
  );
  const action =
    startBlockedReason !== null && startBlockedAction !== null ? (
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onPress={() => {
          startBlockedAction.onPress();
        }}
        accessibilityLabel={startBlockedAction.label}
      >
        <Text>{startBlockedAction.label}</Text>
      </Button>
    ) : null;

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
        {action}
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
      {action}
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
