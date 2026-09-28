/**
 * Canonical session-message fixtures shared by the queue and recovery unit tests.
 * They build the `{v:2}`-shaped `SessionMessage` union so tests assert the stored
 * representation rather than a flat row.
 */
import type {
  AcceptedMessageState,
  Cancellation,
  MessageProofs,
  MessageState,
  QueuedMessageState,
  SessionMessage,
} from '../sandbox-state/model/session.js';

export function queuedState(overrides: Partial<QueuedMessageState> = {}): QueuedMessageState {
  return {
    kind: 'queued',
    intent: null,
    legacyInvalidIntent: true,
    deliveryStep: 'waiting',
    deadlineAt: null,
    attachFailures: 0,
    promptFailures: 0,
    ...overrides,
  };
}

export function acceptedState(overrides: Partial<AcceptedMessageState> = {}): AcceptedMessageState {
  return {
    kind: 'accepted',
    intent: null,
    legacyInvalidIntent: true,
    acceptedAt: 1,
    executionDeadlineAt: 2,
    ...overrides,
  };
}

export function terminalState(
  kind: 'completed' | 'failed' | 'cancelled',
  overrides: Record<string, unknown> = {}
): MessageState {
  return {
    kind,
    intent: null,
    legacyInvalidIntent: true,
    at: 1,
    source: 'coordinator',
    ...overrides,
  } as MessageState;
}

export function queuedMessage(
  messageId: string,
  state: Partial<QueuedMessageState> = {},
  fields: { proofs?: MessageProofs; cancellation?: Cancellation } = {}
): SessionMessage {
  return { messageId, state: queuedState(state), ...fields };
}

export function acceptedMessage(
  messageId: string,
  state: Partial<AcceptedMessageState> = {},
  fields: { proofs?: MessageProofs; cancellation?: Cancellation } = {}
): SessionMessage {
  return { messageId, state: acceptedState(state), ...fields };
}
