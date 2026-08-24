import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';

import { confirmRemoteSessionExit } from './remote-session-exit-confirmation';

/**
 * Classifier literals copied from `exit-remote-session-with-feedback.ts`. They
 * must stay in sync with that file (which pins them to the SDK source). The
 * barrel import is not used here because the mobile test runner cannot resolve
 * the SDK's transitive web-only `@/...` aliases.
 */
const REMOTE_SESSION_EXIT_NOT_SUPPORTED_MESSAGE =
  'Remote session exit is not supported for the current session';
const REMOTE_SESSION_EXIT_UNAVAILABLE_MESSAGE =
  'Remote session exit is unavailable for the current session';
const REMOTE_SESSION_EXIT_UPGRADE_PREFIX = 'Remote slash commands require a newer Kilo CLI';
const RETRY_TOAST_LABEL = 'Try again';
const FALLBACK_ERROR_MESSAGE = 'Failed to exit session';

const NON_RETRYABLE_EXIT_MESSAGES: ReadonlySet<string> = new Set([
  REMOTE_SESSION_EXIT_NOT_SUPPORTED_MESSAGE,
  REMOTE_SESSION_EXIT_UNAVAILABLE_MESSAGE,
]);

function isNonRetryableExitError(message: string): boolean {
  if (NON_RETRYABLE_EXIT_MESSAGES.has(message)) {
    return true;
  }
  return message.startsWith(REMOTE_SESSION_EXIT_UPGRADE_PREFIX);
}

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
        const message = error instanceof Error ? error.message : FALLBACK_ERROR_MESSAGE;
        if (isNonRetryableExitError(message)) {
          // Fail-closed: the SDK signalled "do not send". No CTA so the user
          // sees the copy but cannot trigger another attempt.
          announcingToast.error(message);
        } else {
          // Retryable transport / ACK failure. The retry action re-runs the
          // send without a second confirm.
          announcingToast.error(message, {
            action: {
              label: RETRY_TOAST_LABEL,
              onClick: () => {
                void runSend();
              },
            },
          });
        }
        return;
      }

      announcingToast.success(i18n.t('agents.sessionExited'));
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
