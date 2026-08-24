import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';
import { resolveMessageDisplayModel } from './message-model-label';

/**
 * Report AI response helper. Pure: the details sheet wires the confirm and
 * the mutation. No message body text is ever returned, logged, or placed in a
 * toast — the report input is minimized to surface, ids, model, and platform.
 */

export type ReportAiResponseInput = inferRouterInputs<MobileRouter>['moderation']['reportContent'];

const REPORT_PLATFORM = 'mobile';

/** Show the control only on assistant messages that carry an id. */
export function shouldShowReportAiResponse(message: StoredMessage | null): boolean {
  if (message === null) {
    return false;
  }
  return message.info.role === 'assistant' && message.info.id.length > 0;
}

/** Build the minimized report input. Returns null when the message is not reportable. */
export function buildReportAiResponseInput(message: StoredMessage): ReportAiResponseInput | null {
  if (message.info.role !== 'assistant' || message.info.id.length === 0) {
    return null;
  }
  const modelId = resolveMessageDisplayModel(message)?.modelID ?? message.info.modelID;
  return {
    surface: 'ai_output',
    targetKind: 'message',
    targetId: message.info.id,
    modelId,
    sessionId: message.info.sessionID,
    reason: 'other',
    context: { platform: REPORT_PLATFORM },
  };
}

export type ReportAiResponseFailure =
  | { retryable: true; message: string }
  | { retryable: false; message: string };

/** Error toast shape: the message plus an optional retry action. */
export type ReportAiResponseErrorToast = {
  message: string;
  action?: { label: string; onClick: () => void };
};

/**
 * Build the submit-failure toast. A retryable failure carries a Retry action
 * that re-runs the supplied `retry` callback; a terminal failure carries no
 * action so the user cannot trigger another attempt.
 */
export function buildReportAiResponseErrorToast(
  failure: ReportAiResponseFailure,
  retry: () => void
): ReportAiResponseErrorToast {
  if (failure.retryable) {
    return { message: failure.message, action: { label: i18n.t('common.retry'), onClick: retry } };
  }
  return { message: failure.message };
}

/**
 * Classify a submit failure as retryable (network / 5xx) or terminal
 * (forbidden / validation). Terminal codes must never be retried.
 */
export function classifyReportAiResponseFailure(error: unknown): ReportAiResponseFailure {
  const code = readTrpcErrorField(error, 'code');
  if (isTerminalTrpcCode(code)) {
    return {
      retryable: false,
      message: i18n.t('agentChat.messageDetails.reportAiResponseFailedTerminal'),
    };
  }
  return {
    retryable: true,
    message: i18n.t('agentChat.messageDetails.reportAiResponseFailedRetryable'),
  };
}

/** Submitted toast copy: the receipt id only, never the message body. */
export function reportAiResponseSubmittedToast(receiptId: string): string {
  return i18n.t('agentChat.messageDetails.reportAiResponseSubmitted', { receiptId });
}
