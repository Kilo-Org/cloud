import type {
  SafeMessageResultPreparation,
  SafeMessageResultResponse,
} from '../../session/message-result.js';
import { SAFE_FAILURE_MESSAGE_MAX_LENGTH } from '../../session/safe-failure-projection.js';
import { isTerminalFailureRetryable } from '../../session/terminal-error-projector.js';
import type { PreparationAttempt } from '../../shared/protocol.js';
import { messageFailureText } from './failure-messages.js';
import { isTerminalMessage, type SessionMessage } from './messages.js';
import { projectSettledMessageFailure } from './reports.js';
import { labelWithoutCommand } from './setup-command-label.js';

const RESULT_STATUS: Record<SessionMessage['state'], SafeMessageResultResponse['status']> = {
  queued: 'queued',
  accepted: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'interrupted',
};

export function summarizeMessagePreparation(
  attempt: PreparationAttempt | null | undefined
): SafeMessageResultPreparation | undefined {
  if (attempt == null) return undefined;
  const failedStep = attempt.steps.findLast(step => step.status === 'failed');
  const safeError =
    failedStep?.safeError ?? (attempt.status === 'failed' ? attempt.safeError : undefined);
  return {
    status: attempt.status,
    failedStepLabel: failedStep === undefined ? undefined : labelWithoutCommand(failedStep),
    reason:
      safeError === undefined
        ? undefined
        : messageFailureText(safeError).slice(0, SAFE_FAILURE_MESSAGE_MAX_LENGTH),
  };
}

export function projectMessageResult({
  cloudAgentSessionId,
  message,
  readAssistantText,
  readPreparation,
}: {
  cloudAgentSessionId: string;
  message: SessionMessage;
  readAssistantText: (assistantMessageId: string) => string | undefined;
  readPreparation: () => PreparationAttempt | null | undefined;
}): SafeMessageResultResponse {
  const { settlement } = message;
  const projected = projectSettledMessageFailure(message, settlement?.facts ?? {});
  const assistantMessageId =
    message.state === 'completed' ? settlement?.assistantMessageId : undefined;
  const gateResult = message.state === 'completed' ? settlement?.facts?.gateResult : undefined;
  const branch = isTerminalMessage(message.state) ? settlement?.branch : undefined;
  const preparation = summarizeMessagePreparation(readPreparation());
  return {
    cloudAgentSessionId,
    messageId: message.messageId,
    status: RESULT_STATUS[message.state],
    createdAt: message.createdAt,
    ...(message.acceptedAt === null ? {} : { acceptedAt: message.acceptedAt }),
    ...(message.settledAt === null ? {} : { terminalAt: message.settledAt }),
    ...(projected === undefined
      ? {}
      : {
          failure: {
            ...projected,
            retryable: isTerminalFailureRetryable({
              failureStage: projected.stage,
              failureCode: projected.code,
            }),
          },
        }),
    ...(gateResult === undefined ? {} : { gateResult }),
    ...(assistantMessageId === undefined
      ? {}
      : {
          assistant: {
            messageId: assistantMessageId,
            text: readAssistantText(assistantMessageId)?.trim() || undefined,
          },
        }),
    ...(branch === undefined ? {} : { branch }),
    ...(preparation === undefined ? {} : { preparation }),
  };
}
