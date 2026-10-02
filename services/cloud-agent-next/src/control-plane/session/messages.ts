import type { ControlPlanePromptPayload } from '../../shared/control-plane-protocol.js';
import type { ControlPlaneTimers } from '../../shared/control-plane-timers.js';

/**
 * Spec §5 message state: `queued → accepted → completed | failed | cancelled`.
 * One state value per message; a terminal state is final. The reducer below is
 * the one place a message state changes; the DO owns storage and side effects.
 */
export const SESSION_MESSAGE_STATES = [
  'queued',
  'accepted',
  'completed',
  'failed',
  'cancelled',
] as const;
export type SessionMessageState = (typeof SESSION_MESSAGE_STATES)[number];

export const TERMINAL_MESSAGE_STATES = ['completed', 'failed', 'cancelled'] as const;

/**
 * The public queue capacity: the most `queued` (not accepted) messages a
 * session admits. The legacy public limit (10) and its public 429
 * `PENDING_QUEUE_FULL` error are the public contract kept by the execution
 * brief's queue-capacity decision, recorded in the execution ledger. This is not
 * a spec §5 rule, so do not delete it for being absent from the spec.
 * `accepted` messages do not count: a message on a `ready` route is delivered,
 * not queued.
 */
export const QUEUED_MESSAGE_LIMIT = 10;

/** One message row: identity, immutable intent, one state, timestamps, reason. */
export type SessionMessage = {
  messageId: string;
  intent: ControlPlanePromptPayload;
  state: SessionMessageState;
  createdAt: number;
  acceptedAt: number | null;
  settledAt: number | null;
  reason: string | null;
};

/** The messages a reducer changed, so the caller can emit their events. */
export type MessageReduction = {
  messages: SessionMessage[];
  changed: SessionMessage[];
  /** Set when a new message was refused because the queued bound is reached. */
  rejected?: 'queue-full';
};

export function isTerminalMessage(state: SessionMessageState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function isOpenMessage(message: SessionMessage): boolean {
  return message.state === 'queued' || message.state === 'accepted';
}

/** The oldest still-open message, by insertion order. */
export function oldestOpenMessage(
  messages: readonly SessionMessage[],
  state?: 'queued' | 'accepted'
): SessionMessage | undefined {
  return messages.find(message =>
    state === undefined ? isOpenMessage(message) : message.state === state
  );
}

/**
 * Append a `queued` message. Idempotent: a repeated send for the same id (a
 * queued or accepted replay) changes nothing, and a terminal id is final and
 * must not be re-admitted (spec §5, AGENTS.md message-id rule). A new message
 * is refused once the queued bound is reached, so the bound cannot be exceeded
 * (a replay is still admitted).
 */
export function queueMessage(
  messages: readonly SessionMessage[],
  intent: ControlPlanePromptPayload,
  now: number
): MessageReduction {
  if (messages.some(message => message.messageId === intent.messageId)) {
    return { messages: [...messages], changed: [] };
  }
  if (messages.filter(message => message.state === 'queued').length >= QUEUED_MESSAGE_LIMIT) {
    return { messages: [...messages], changed: [], rejected: 'queue-full' };
  }
  const message: SessionMessage = {
    messageId: intent.messageId,
    intent,
    state: 'queued',
    createdAt: now,
    acceptedAt: null,
    settledAt: null,
    reason: null,
  };
  return { messages: [...messages, message], changed: [message] };
}

/** Move `queued` messages to `accepted`; other states are left untouched. */
export function acceptMessages(
  messages: readonly SessionMessage[],
  messageIds: readonly string[],
  now: number
): MessageReduction {
  const ids = new Set(messageIds);
  const changed: SessionMessage[] = [];
  const next = messages.map(message => {
    if (!ids.has(message.messageId) || message.state !== 'queued') return message;
    const accepted: SessionMessage = { ...message, state: 'accepted', acceptedAt: now };
    changed.push(accepted);
    return accepted;
  });
  return { messages: next, changed };
}

/**
 * Move the given non-terminal messages to a terminal state. A message already
 * terminal is ignored, so a late duplicate settlement is a no-op.
 */
export function settleMessages(
  messages: readonly SessionMessage[],
  messageIds: readonly string[],
  status: Extract<SessionMessageState, 'completed' | 'failed' | 'cancelled'>,
  reason: string | undefined,
  now: number
): MessageReduction {
  const ids = new Set(messageIds);
  const changed: SessionMessage[] = [];
  const next = messages.map(message => {
    if (!ids.has(message.messageId) || isTerminalMessage(message.state)) return message;
    const settled: SessionMessage = {
      ...message,
      state: status,
      settledAt: now,
      reason: status === 'completed' ? null : (reason ?? null),
    };
    changed.push(settled);
    return settled;
  });
  return { messages: next, changed };
}

/**
 * Apply an outcome to the accepted messages up to and including `lastMessageId`.
 * A late outcome naming a message that is not accepted (terminal or queued) is
 * ignored, so it cannot end a newer turn. "All accepted" applies only when no
 * message has the id (spec §5).
 */
export function settleAcceptedUpTo(
  messages: readonly SessionMessage[],
  lastMessageId: string,
  status: Extract<SessionMessageState, 'completed' | 'failed' | 'cancelled'>,
  reason: string | undefined,
  now: number
): MessageReduction {
  const named = messages.find(message => message.messageId === lastMessageId);
  if (named !== undefined && named.state !== 'accepted') {
    return { messages: [...messages], changed: [] };
  }
  const accepted = messages.filter(message => message.state === 'accepted');
  const targets = named === undefined ? accepted : accepted.slice(0, accepted.indexOf(named) + 1);
  return settleMessages(
    messages,
    targets.map(message => message.messageId),
    status,
    reason,
    now
  );
}

/** Every non-terminal message, in order. */
export function openMessages(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.filter(isOpenMessage);
}

/**
 * The messages whose backstop deadline has passed (spec §5). `queued` messages
 * fail as `preparation_timeout`; `accepted` messages as `no_outcome`.
 */
export function dueBackstopMessages(
  messages: readonly SessionMessage[],
  now: number,
  timers: ControlPlaneTimers['session']
): Array<{
  message: SessionMessage;
  status: 'failed';
  reason: 'preparation_timeout' | 'no_outcome';
}> {
  const due: Array<{
    message: SessionMessage;
    status: 'failed';
    reason: 'preparation_timeout' | 'no_outcome';
  }> = [];
  for (const message of messages) {
    if (message.state === 'queued' && message.createdAt + timers.queuedBackstopMs <= now) {
      due.push({ message, status: 'failed', reason: 'preparation_timeout' });
    } else if (
      message.state === 'accepted' &&
      message.acceptedAt !== null &&
      message.acceptedAt + timers.acceptedBackstopMs <= now
    ) {
      due.push({ message, status: 'failed', reason: 'no_outcome' });
    }
  }
  return due;
}

/** The earliest backstop deadline of the open messages, or null when none. */
export function nextBackstopAt(
  messages: readonly SessionMessage[],
  timers: ControlPlaneTimers['session']
): number | null {
  const deadlines: number[] = [];
  for (const message of messages) {
    if (message.state === 'queued') deadlines.push(message.createdAt + timers.queuedBackstopMs);
    else if (message.state === 'accepted' && message.acceptedAt !== null) {
      deadlines.push(message.acceptedAt + timers.acceptedBackstopMs);
    }
  }
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

/** Public `cloud.message.queued` snapshot content for a stored intent. */
export function renderTurnContent(intent: ControlPlanePromptPayload): string {
  if (intent.turn.type === 'command') {
    return `/${intent.turn.command}${intent.turn.arguments ? ` ${intent.turn.arguments}` : ''}`;
  }
  return intent.turn.prompt;
}
