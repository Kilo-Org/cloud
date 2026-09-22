import type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
} from '@kilocode/worker-utils/cloud-agent-failure';
import {
  classifyAssistantFailure,
  isAssistantInterrupt,
  projectSafeAssistantError,
} from '../shared/assistant-failure.js';
import type { AssistantMessageInfo, LatestAssistantMessage } from '../session/types.js';
import type { SessionMessageRecord } from './session-message-queue.js';

/**
 * A settlement for an accepted turn read from the DO's stored kilocode events.
 * Positive terminal evidence only: a silent runtime can have streamed a partial
 * answer, and that is not terminal.
 */
export type AcceptedStoredSettlement = {
  state: 'completed' | 'failed' | 'cancelled';
  failedReason?: string;
  failedDetail?: string;
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
};

function hasAssistantCompletionMarker(info: AssistantMessageInfo): boolean {
  const time = info.time;
  if (typeof time !== 'object' || time === null || !('completed' in time)) return false;
  return typeof time.completed === 'number';
}

/**
 * Project the stored assistant answer for a user message into a terminal
 * settlement, mirroring the legacy wrapper-death reconciliation
 * (`projectWrapperDeathReconciliation`). `undefined` means no positive terminal
 * evidence, so the caller may still recover the turn.
 */
export function projectStoredAssistantSettlement(
  assistant: LatestAssistantMessage | null
): AcceptedStoredSettlement | undefined {
  if (!assistant) return undefined;
  const error = assistant.info.error;
  if (error !== undefined && error !== null) {
    if (isAssistantInterrupt(error)) return { state: 'cancelled', failedReason: 'interrupted' };
    const failure = classifyAssistantFailure(error);
    return {
      state: 'failed',
      failedReason: 'assistant_error',
      failedDetail: projectSafeAssistantError(error) ?? 'Assistant request failed',
      assistantReason: failure.reason,
      providerOwnership: failure.providerOwnership,
    };
  }
  if (!hasAssistantCompletionMarker(assistant.info)) return undefined;
  return { state: 'completed' };
}

/**
 * Apply a stored-assistant settlement to the matching accepted record. Returns
 * `undefined` when the record is gone or no longer accepted, so a stale read
 * cannot override a newer transition. The terminal source stays `coordinator`:
 * the wrapper never reported this settlement.
 */
export function applyStoredAssistantSettlement(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  settlement: AcceptedStoredSettlement,
  now: number
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (!message || message.state !== 'accepted') return undefined;
  return messages.map(item =>
    item.messageId !== messageId
      ? item
      : {
          ...item,
          state: settlement.state,
          unresolvedDispatch: undefined,
          terminalAt: now,
          terminalSource: 'coordinator',
          ...(settlement.failedReason ? { failedReason: settlement.failedReason } : {}),
          ...(settlement.failedDetail ? { failedDetail: settlement.failedDetail } : {}),
          ...(settlement.assistantReason ? { assistantReason: settlement.assistantReason } : {}),
          ...(settlement.providerOwnership
            ? { providerOwnership: settlement.providerOwnership }
            : {}),
        }
  );
}
