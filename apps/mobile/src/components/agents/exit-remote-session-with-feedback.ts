import { toast } from 'sonner-native';

import { type AgentSessionRouterLike } from '@/components/agents/session-router-like';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

type ExitRemoteSessionWithFeedbackInput = {
  exit: () => Promise<void>;
  onAccepted: () => void;
  router: AgentSessionRouterLike;
  /**
   * The composer SubmitLock, exposed as a `{ current: boolean }` ref so the
   * retry action can re-acquire the same admission gate the initial send
   * used. The helper holds this lock for the full retry mutation window via
   * `settleVoiceInputBeforeSubmit`.
   */
  lock: { current: boolean };
  /**
   * The same voice-input settle callback the initial send used. The retry
   * must wait for any in-flight voice transcript before re-running the exit
   * mutation under the lock above.
   */
  settleVoiceInput?: () => Promise<boolean>;
};

const SESSIONS_ROUTE = '/(app)/(tabs)/(2_agents)' as const;
const SESSION_EXITED_MESSAGE = 'Session exited';
/**
 * Pinned to the SDK's exported `REMOTE_SESSION_EXIT_NOT_SUPPORTED` constant
 * (see `apps/web/src/lib/cloud-agent-sdk/session.ts`). The barrel import is
 * not used here because the mobile test runner cannot resolve the SDK's
 * transitive web-only `@/...` aliases; the literal must stay in sync with
 * the SDK source. The same pinning rule applies to the two literals below.
 */
const REMOTE_SESSION_EXIT_NOT_SUPPORTED_MESSAGE =
  'Remote session exit is not supported for the current session';
/**
 * Internal SDK message: `cli-live-transport` throws this when the live
 * catalog reports a non-`true` `canExitSession`. The SDK does not export the
 * constant, so the literal is matched here. The producer/consumer contract
 * pins these strings — changing them requires updating this classifier.
 */
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

export async function exitRemoteSessionWithFeedback({
  exit,
  onAccepted,
  router,
  lock,
  settleVoiceInput = async () => {
    await Promise.resolve();
    return true;
  },
}: Readonly<ExitRemoteSessionWithFeedbackInput>): Promise<void> {
  const runExit = async (): Promise<void> => {
    try {
      await exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : FALLBACK_ERROR_MESSAGE;
      if (isNonRetryableExitError(message)) {
        // Fail-closed: the SDK already signalled "do not send" by rejecting
        // before any wire command. Surface the message with no CTA so the
        // user sees the upgrade copy but cannot trigger another attempt.
        toast.error(message);
      } else {
        // Retryable: transport / ACK / heartbeat failure. The draft is
        // preserved by the submit-lock contract; the retry action re-runs
        // the exit mutation under the same SubmitLock the initial send held.
        toast.error(message, {
          action: {
            label: RETRY_TOAST_LABEL,
            onClick: () => {
              void (async () => {
                try {
                  await settleVoiceInputBeforeSubmit({
                    lock,
                    settleVoiceInput,
                    submit: runExit,
                  });
                } catch {
                  // Retry errors are already surfaced by the toast inside
                  // runExit; swallow them so the async action does not leak
                  // an unhandled promise rejection.
                }
              })();
            },
          },
        });
      }
      throw error;
    }

    toast.success(SESSION_EXITED_MESSAGE);
    onAccepted();
    router.replace(SESSIONS_ROUTE);
  };

  await runExit();
}
