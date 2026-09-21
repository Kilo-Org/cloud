import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';

import { confirmRemoteSessionExit } from './remote-session-exit-confirmation';
import { isNonRetryableExitError } from './remote-session-exit-messages';

type ExitRemoteSessionFromListInput = {
  confirm: () => Promise<boolean>;
  sendExit: () => Promise<void>;
  refreshActiveList: () => Promise<void>;
  inFlight: { current: boolean };
};

/**
 * Exit a running session from the Active now list. Keeps history and never
 * opens the session. The row passes `showRemoteSessionExitConfirmation` as
 * `confirm`; this helper wraps `confirmRemoteSessionExit` once and owns the
 * send/refresh/toast lifecycle. `inFlight` is a shared ref flag that blocks
 * a second exit while one is in flight.
 */
export async function exitRemoteSessionFromList({
  confirm,
  sendExit,
  refreshActiveList,
  inFlight,
}: Readonly<ExitRemoteSessionFromListInput>): Promise<void> {
  if (inFlight.current) {
    return;
  }

  const runSend = async (): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      try {
        await sendExit();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : i18n.t('agentChat.remoteSession.failedToExit');
        if (isNonRetryableExitError(message)) {
          // Fail-closed: the SDK signalled "do not send". No CTA so the user
          // sees the copy but cannot trigger another attempt.
          announcingToast.error(message);
        } else {
          // Retryable transport / ACK failure. The retry action re-runs the
          // send without a second confirm.
          announcingToast.error(message, {
            action: {
              label: i18n.t('common.tryAgain'),
              onClick: () => {
                void runSend();
              },
            },
          });
        }
        return;
      }

      announcingToast.success(i18n.t('common.sessionExited'));
      try {
        await refreshActiveList();
      } catch {
        // Swallow the refresh failure: the row already left the live set via
        // the send. Do not resend `exit_cli`; the user can pull to refresh.
      }
    } finally {
      inFlight.current = false;
    }
  };

  await confirmRemoteSessionExit(confirm, runSend);
}
