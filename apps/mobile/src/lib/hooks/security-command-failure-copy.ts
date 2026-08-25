import { i18n } from '@/i18n';
import { type SecurityCommand } from '@/lib/security-agent';

// Failure copy is chosen from a stable result code. Web still reads the
// shared English strings in packages/app-shared/src/security-agent/commands.ts,
// so mobile maps each code to a catalog key and translates at toast time.
const FAILURE_MESSAGE_KEY_BY_RESULT_CODE = {
  OWNER_CAP_REACHED: 'securityAgent.commandFailure.ownerCapReached',
  GITHUB_TOKEN_UNAVAILABLE: 'securityAgent.commandFailure.githubTokenUnavailable',
  GITHUB_AUTH_INVALID: 'securityAgent.commandFailure.githubAuthInvalid',
  FINDING_UNAVAILABLE: 'securityAgent.commandFailure.findingUnavailable',
  REPOSITORY_UNAVAILABLE: 'securityAgent.commandFailure.repositoryUnavailable',
  INVALID_DISMISS_TARGET: 'securityAgent.commandFailure.invalidDismissTarget',
  COMMAND_STALLED: 'securityAgent.commandFailure.commandStalled',
  QUEUE_RETRIES_EXHAUSTED: 'securityAgent.commandFailure.queueRetriesExhausted',
} satisfies Record<string, string>;

const QUEUE_ADMISSION_FAILED_KEY = 'securityAgent.commandFailure.queueAdmissionFailed';
const GENERIC_FAILURE_KEY = 'securityAgent.commandFailure.generic';

// Mirrors getSecurityCommandFailureMessage in packages/app-shared: a known
// result code translates to catalog copy; QUEUE_ADMISSION_FAILED and unknown
// codes keep lastErrorRedacted when present, else the translated fallback.
export function getSecurityCommandFailureMessage(command: SecurityCommand): string {
  const knownKey =
    command.resultCode && command.resultCode in FAILURE_MESSAGE_KEY_BY_RESULT_CODE
      ? FAILURE_MESSAGE_KEY_BY_RESULT_CODE[
          command.resultCode as keyof typeof FAILURE_MESSAGE_KEY_BY_RESULT_CODE
        ]
      : undefined;
  if (knownKey) {
    return i18n.t(knownKey);
  }
  if (command.resultCode === 'QUEUE_ADMISSION_FAILED') {
    return command.lastErrorRedacted ?? i18n.t(QUEUE_ADMISSION_FAILED_KEY);
  }
  return command.lastErrorRedacted ?? i18n.t(GENERIC_FAILURE_KEY);
}
