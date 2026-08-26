import { renderExecutionTurnContent, type AcceptedExecutionTurn } from '../execution/types.js';
import type { CloudMessageFailedPayload } from '../session/message-settlement-outbox.js';

export type SessionMessageState = 'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled';

export type SessionMessageRecord = {
  messageId: string;
  state: SessionMessageState;
  acceptedAt?: number;
  lastActivityAt?: number;
  turn?: AcceptedExecutionTurn;
  prompt?: string;
  failedReason?: string;
  attachFailures?: number;
  promptFailures?: number;
  preparationAttemptId?: string;
};

export const ATTACH_FAILURE_LIMIT = 2;
export const PROMPT_FAILURE_LIMIT = 5;

export function assignPreparationAttemptId(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  mint: () => string
): { messages: SessionMessageRecord[]; attemptId: string } | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (!message) return undefined;
  if (message.preparationAttemptId) {
    return {
      messages: messages as SessionMessageRecord[],
      attemptId: message.preparationAttemptId,
    };
  }
  const attemptId = mint();
  return {
    messages: messages.map(item =>
      item.messageId === messageId ? { ...item, preparationAttemptId: attemptId } : item
    ),
    attemptId,
  };
}

export function failWaitingMessages(
  messages: readonly SessionMessageRecord[],
  reason: string
): { messages: SessionMessageRecord[]; failedIds: string[] } {
  const failedIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' && message.state !== 'accepted') return message;
      failedIds.push(message.messageId);
      return { ...message, state: 'failed', failedReason: reason };
    }),
    failedIds,
  };
}

export function incrementAttachFailure(
  messages: readonly SessionMessageRecord[],
  messageId: string
): { messages: SessionMessageRecord[]; failures: number } {
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId) return message;
      failures = (message.attachFailures ?? 0) + 1;
      return { ...message, attachFailures: failures };
    }),
    failures,
  };
}

export function incrementPromptFailure(
  messages: readonly SessionMessageRecord[],
  messageId: string
): { messages: SessionMessageRecord[]; failures: number } {
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId) return message;
      failures = (message.promptFailures ?? 0) + 1;
      return { ...message, promptFailures: failures };
    }),
    failures,
  };
}

export function isAttachExhausted(failures: number): boolean {
  return failures >= ATTACH_FAILURE_LIMIT;
}

export function isPromptExhausted(failures: number): boolean {
  return failures >= PROMPT_FAILURE_LIMIT;
}

export function nextQueuedMessageId(messages: readonly SessionMessageRecord[]): string | undefined {
  if (messages.some(message => message.state === 'accepted')) return undefined;
  return messages.find(message => message.state === 'queued')?.messageId;
}

export function userTurnTerminalState(
  type: string,
  kiloSessionId?: string,
  rootKiloSessionId?: string
): 'completed' | 'failed' | undefined {
  if (
    kiloSessionId !== undefined &&
    rootKiloSessionId !== undefined &&
    kiloSessionId !== rootKiloSessionId
  ) {
    return undefined;
  }
  if (type === 'session.turn.close') return 'completed';
  if (type === 'session.error') return 'failed';
  return undefined;
}

export function terminalizeAcceptedMessages(
  messages: readonly SessionMessageRecord[],
  state: 'completed' | 'failed'
): SessionMessageRecord[] {
  return messages.map(message => (message.state === 'accepted' ? { ...message, state } : message));
}

export function hasAcceptedMessage(messages: readonly SessionMessageRecord[]): boolean {
  return messages.some(message => message.state === 'accepted');
}

export function cancelActiveMessages(messages: readonly SessionMessageRecord[]): {
  messages: SessionMessageRecord[];
  cancelledIds: string[];
} {
  const cancelledIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' && message.state !== 'accepted') return message;
      cancelledIds.push(message.messageId);
      return { ...message, state: 'cancelled' };
    }),
    cancelledIds,
  };
}

export function failQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string
): SessionMessageRecord[] | undefined {
  if (!messages.some(message => message.messageId === messageId && message.state === 'queued')) {
    return undefined;
  }
  return messages.map(message =>
    message.messageId === messageId && message.state === 'queued'
      ? { ...message, state: 'failed' }
      : message
  );
}

export function acceptQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  acceptedAt: number
): SessionMessageRecord[] | undefined {
  if (nextQueuedMessageId(messages) !== messageId) return undefined;
  return messages.map(message =>
    message.messageId === messageId
      ? { ...message, state: 'accepted', acceptedAt, lastActivityAt: acceptedAt }
      : message
  );
}

export function recordAcceptedMessageActivity(
  messages: readonly SessionMessageRecord[],
  lastActivityAt: number
): SessionMessageRecord[] | undefined {
  if (!hasAcceptedMessage(messages)) return undefined;
  return messages.map(message =>
    message.state === 'accepted' ? { ...message, lastActivityAt } : message
  );
}

export function hasInterruptibleWork(messages: readonly SessionMessageRecord[]): boolean {
  return messages.some(
    message =>
      message.state === 'queued' || message.state === 'accepted' || message.state === 'cancelled'
  );
}

export type StreamQueuedSnapshot = {
  messageId: string;
  content: string;
  timestamp: number;
  terminalFailure?: CloudMessageFailedPayload & { timestamp: number };
};

export function failedMessageSnapshot(
  message: SessionMessageRecord,
  now: number
): CloudMessageFailedPayload & { timestamp: number } {
  const accepted = message.acceptedAt !== undefined;
  return {
    messageId: message.messageId,
    status: 'failed',
    delivery: accepted ? 'sent' : 'queued',
    accepted,
    reason: message.failedReason,
    timestamp: message.acceptedAt ?? now,
  };
}

export function streamQueuedSnapshots(
  messages: readonly SessionMessageRecord[],
  now: number
): StreamQueuedSnapshot[] {
  return messages
    .filter(
      message =>
        message.state === 'queued' || message.state === 'accepted' || message.state === 'failed'
    )
    .map(message => ({
      messageId: message.messageId,
      content: message.turn ? renderExecutionTurnContent(message.turn) : (message.prompt ?? ''),
      timestamp: message.acceptedAt ?? now,
      ...(message.state === 'failed'
        ? { terminalFailure: failedMessageSnapshot(message, now) }
        : {}),
    }));
}

export function streamCloudStatus(
  messages: readonly SessionMessageRecord[]
): { type: 'preparing' } | { type: 'ready' } | null {
  if (messages.some(message => message.state === 'queued' || message.state === 'accepted')) {
    return { type: 'preparing' };
  }
  return messages.length > 0 ? { type: 'ready' } : null;
}
