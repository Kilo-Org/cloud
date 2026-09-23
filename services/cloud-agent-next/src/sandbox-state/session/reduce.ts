/**
 * Session / message reducer (design §7). Pure: no I/O, no clock read, no storage.
 * The session never creates/destroys/observes a sandbox, never decides health,
 * never extends a delivery deadline, and never replays accepted or
 * possibly-executed work.
 *
 * Every decision reports the aggregate's single deadline through `sessionAlarmAt`,
 * and a loss notification is fenced by the proof's incarnation/wrapper against the
 * bound handle before any message is mutated.
 */
import type { Decision } from '../commands.js';
import { operationId } from '../commands.js';
import type { StateMeta, TransitionMeta } from '../registry.js';
import type { SessionEvent } from '../events.js';
import type {
  Binding,
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
  GateResult,
  MessageProofs,
  MessageState,
  SessionAggregate,
  SessionMessage,
  SessionMessageIntent,
  SessionMessageTerminalSource,
} from '../model/session.js';
import { POLICY, sessionAlarmAt } from '../schedule.js';

export const SESSION = 'session';

export const SESSION_STATES: readonly StateMeta[] = [
  {
    kind: 'unbound',
    terminal: false,
    hasDeadline: false,
    namedExits: ['BIND', 'ENQUEUE', 'DEMAND'],
  },
  {
    kind: 'bound',
    terminal: false,
    hasDeadline: false,
    namedExits: ['UNBIND', 'ENQUEUE', 'STOPPED'],
  },
  {
    kind: 'unresolved',
    terminal: false,
    hasDeadline: false,
    namedExits: ['BIND', 'UNBIND', 'ENQUEUE'],
  },
  {
    kind: 'queued',
    terminal: false,
    hasDeadline: true,
    namedExits: ['ACCEPT', 'CANCEL', 'OUTCOME', 'STOPPED'],
  },
  {
    kind: 'accepted',
    terminal: false,
    hasDeadline: true,
    namedExits: ['CANCEL', 'OUTCOME', 'STOPPED'],
  },
  { kind: 'completed', terminal: true, hasDeadline: false, namedExits: [] },
  { kind: 'failed', terminal: true, hasDeadline: false, namedExits: [] },
  { kind: 'cancelled', terminal: true, hasDeadline: false, namedExits: [] },
];

export const SESSION_EVENT_TYPES = [
  'ENQUEUE',
  'BIND',
  'UNBIND',
  'DEMAND',
  'ACCEPT',
  'DELIVERY_STEP',
  'RECORD_PROOF',
  'RECORD_CANCELLATION',
  'OUTCOME',
  'CANCEL',
  'STOPPED',
  'DEADLINE',
] as const;

export const SESSION_TRANSITIONS: readonly TransitionMeta[] = [
  // Binding events. Message-state representatives are bound, so BIND is accepted
  // (same handle) and UNBIND is accepted from every message state.
  { from: 'unbound', event: 'BIND', to: 'bound', commands: [], deadline: null },
  { from: 'unresolved', event: 'BIND', to: 'bound', commands: [], deadline: null },
  { from: 'bound', event: 'BIND', to: 'bound', commands: [], deadline: null },
  { from: 'queued', event: 'BIND', to: 'queued', commands: [], deadline: null },
  { from: 'accepted', event: 'BIND', to: 'accepted', commands: [], deadline: null },
  { from: 'completed', event: 'BIND', to: 'completed', commands: [], deadline: null },
  { from: 'failed', event: 'BIND', to: 'failed', commands: [], deadline: null },
  { from: 'cancelled', event: 'BIND', to: 'cancelled', commands: [], deadline: null },
  { from: 'bound', event: 'UNBIND', to: 'unbound', commands: [], deadline: null },
  { from: 'unresolved', event: 'UNBIND', to: 'unbound', commands: [], deadline: null },
  { from: 'queued', event: 'UNBIND', to: 'queued', commands: [], deadline: null },
  { from: 'completed', event: 'UNBIND', to: 'completed', commands: [], deadline: null },
  { from: 'failed', event: 'UNBIND', to: 'failed', commands: [], deadline: null },
  { from: 'cancelled', event: 'UNBIND', to: 'cancelled', commands: [], deadline: null },

  { from: 'unbound', event: 'DEMAND', to: 'unbound', commands: ['Acquire'], deadline: null },

  { from: 'unbound', event: 'ENQUEUE', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'bound', event: 'ENQUEUE', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'unresolved', event: 'ENQUEUE', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'queued', event: 'ENQUEUE', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'accepted', event: 'ENQUEUE', to: 'accepted', commands: [], deadline: 'delivery' },
  { from: 'completed', event: 'ENQUEUE', to: 'completed', commands: [], deadline: null },
  { from: 'failed', event: 'ENQUEUE', to: 'failed', commands: [], deadline: null },
  { from: 'cancelled', event: 'ENQUEUE', to: 'cancelled', commands: [], deadline: null },

  { from: 'queued', event: 'ACCEPT', to: 'accepted', commands: [], deadline: 'delivery' },
  { from: 'queued', event: 'DELIVERY_STEP', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'queued', event: 'RECORD_PROOF', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'queued', event: 'RECORD_CANCELLATION', to: 'queued', commands: [], deadline: 'cancel' },
  { from: 'queued', event: 'OUTCOME', to: 'completed', commands: [], deadline: null },
  { from: 'queued', event: 'OUTCOME', to: 'failed', commands: [], deadline: null },
  { from: 'queued', event: 'OUTCOME', to: 'cancelled', commands: [], deadline: null },
  { from: 'queued', event: 'CANCEL', to: 'cancelled', commands: [], deadline: null },
  { from: 'queued', event: 'CANCEL', to: 'queued', commands: [], deadline: 'cancel' },

  { from: 'accepted', event: 'RECORD_PROOF', to: 'accepted', commands: [], deadline: 'delivery' },
  {
    from: 'accepted',
    event: 'RECORD_CANCELLATION',
    to: 'accepted',
    commands: [],
    deadline: 'cancel',
  },
  { from: 'accepted', event: 'OUTCOME', to: 'completed', commands: [], deadline: null },
  { from: 'accepted', event: 'OUTCOME', to: 'failed', commands: [], deadline: null },
  { from: 'accepted', event: 'OUTCOME', to: 'cancelled', commands: [], deadline: null },
  { from: 'accepted', event: 'CANCEL', to: 'cancelled', commands: [], deadline: null },

  { from: 'completed', event: 'RECORD_PROOF', to: 'completed', commands: [], deadline: null },
  { from: 'failed', event: 'RECORD_PROOF', to: 'failed', commands: [], deadline: null },
  { from: 'cancelled', event: 'RECORD_PROOF', to: 'cancelled', commands: [], deadline: null },
  {
    from: 'completed',
    event: 'RECORD_CANCELLATION',
    to: 'completed',
    commands: [],
    deadline: null,
  },
  { from: 'failed', event: 'RECORD_CANCELLATION', to: 'failed', commands: [], deadline: null },
  {
    from: 'cancelled',
    event: 'RECORD_CANCELLATION',
    to: 'cancelled',
    commands: [],
    deadline: null,
  },

  { from: 'bound', event: 'STOPPED', to: 'unbound', commands: [], deadline: null },
  { from: 'queued', event: 'STOPPED', to: 'failed', commands: [], deadline: null },
  { from: 'accepted', event: 'STOPPED', to: 'failed', commands: [], deadline: null },
  { from: 'completed', event: 'STOPPED', to: 'completed', commands: [], deadline: null },
  { from: 'failed', event: 'STOPPED', to: 'failed', commands: [], deadline: null },
  { from: 'cancelled', event: 'STOPPED', to: 'cancelled', commands: [], deadline: null },

  { from: 'unbound', event: 'DEADLINE', to: 'unbound', commands: [], deadline: null },
  { from: 'bound', event: 'DEADLINE', to: 'bound', commands: [], deadline: null },
  { from: 'unresolved', event: 'DEADLINE', to: 'unresolved', commands: [], deadline: null },
  { from: 'queued', event: 'DEADLINE', to: 'queued', commands: [], deadline: 'delivery' },
  { from: 'queued', event: 'DEADLINE', to: 'failed', commands: [], deadline: null },
  { from: 'accepted', event: 'DEADLINE', to: 'accepted', commands: [], deadline: 'delivery' },
  { from: 'accepted', event: 'DEADLINE', to: 'failed', commands: [], deadline: null },
  { from: 'completed', event: 'DEADLINE', to: 'completed', commands: [], deadline: null },
  { from: 'failed', event: 'DEADLINE', to: 'failed', commands: [], deadline: null },
  { from: 'cancelled', event: 'DEADLINE', to: 'cancelled', commands: [], deadline: null },
];

/** Fields written only by this reducer. */
export const SESSION_OWNED_FIELDS = [
  'binding',
  'messages',
  'messages.state',
  'messages.proofs',
  'messages.cancellation',
] as const;

/** Registry key: the dominant dimension is the first message when one exists. */
export function sessionStateKey(aggregate: SessionAggregate): string {
  const first = aggregate.messages[0];
  return first ? first.state.kind : aggregate.binding.kind;
}

function isTerminal(state: MessageState): boolean {
  return state.kind === 'completed' || state.kind === 'failed' || state.kind === 'cancelled';
}

/**
 * The single queue-head rule: no accepted message is a head, otherwise the first
 * queued message is. Exported so the session-message queue helpers reuse it
 * instead of re-deriving the rule.
 */
export function headQueuedMessageId(messages: readonly SessionMessage[]): string | undefined {
  if (messages.some(message => message.state.kind === 'accepted')) return undefined;
  return messages.find(message => message.state.kind === 'queued')?.messageId;
}

function headMessageId(aggregate: SessionAggregate): string | undefined {
  return headQueuedMessageId(aggregate.messages);
}

function find(aggregate: SessionAggregate, messageId: string): SessionMessage | undefined {
  return aggregate.messages.find(message => message.messageId === messageId);
}

function replace(
  aggregate: SessionAggregate,
  messageId: string,
  update: (message: SessionMessage) => SessionMessage
): SessionAggregate {
  return {
    ...aggregate,
    messages: aggregate.messages.map(message =>
      message.messageId === messageId ? update(message) : message
    ),
  };
}

/** Immutable carry fields every terminal state must retain. */
function carryFields(state: MessageState): {
  intent: SessionMessageIntent | null;
  legacyInvalidIntent?: true;
  legacy?: NonNullable<MessageState['legacy']>;
  queuedAt?: number;
  wrapperInstanceId?: string;
  preparationAttemptId?: string;
} {
  return {
    intent: state.intent,
    ...(state.legacyInvalidIntent ? { legacyInvalidIntent: true as const } : {}),
    ...(state.legacy !== undefined ? { legacy: state.legacy } : {}),
    ...(state.queuedAt !== undefined ? { queuedAt: state.queuedAt } : {}),
    // The message owns its delivery/settlement identity: ordinary terminalization
    // preserves it so a same-wrapper/same-attempt replay or deferred scope check
    // continues to fence. Allocation-loss terminalization clears it explicitly.
    ...(state.wrapperInstanceId !== undefined
      ? { wrapperInstanceId: state.wrapperInstanceId }
      : {}),
    ...(state.preparationAttemptId !== undefined
      ? { preparationAttemptId: state.preparationAttemptId }
      : {}),
  };
}

/** Any accepted timestamp carried by the previous state (accepted or terminal). */
function carriedAcceptedAt(state: MessageState): number | undefined {
  return state.kind === 'queued' ? undefined : state.acceptedAt;
}

export function terminalMessageState(
  previous: MessageState,
  status: 'completed' | 'failed' | 'cancelled',
  at: number,
  source: SessionMessageTerminalSource,
  extra: {
    reason?: string;
    detail?: string;
    result?: unknown;
    assistantMessageId?: string;
    gateResult?: GateResult;
    assistantReason?: CloudAgentAssistantFailureReason;
    providerOwnership?: CloudAgentProviderOwnership;
  }
): MessageState {
  const carry = carryFields(previous);
  // An already-accepted turn keeps its acceptance time through terminalization;
  // a queued turn settled by a wrapper/operation outcome infers `at`, but a
  // coordinator failure is not an observable dispatch acceptance.
  const acceptedAt = carriedAcceptedAt(previous) ?? (source === 'coordinator' ? undefined : at);
  const acceptance = acceptedAt === undefined ? {} : { acceptedAt };
  if (status === 'completed') {
    return {
      kind: 'completed',
      ...carry,
      ...acceptance,
      at,
      source,
      ...(extra.result !== undefined ? { result: extra.result } : {}),
      ...(extra.assistantMessageId !== undefined
        ? { assistantMessageId: extra.assistantMessageId }
        : {}),
      ...(extra.gateResult !== undefined ? { gateResult: extra.gateResult } : {}),
    };
  }
  if (status === 'failed') {
    return {
      kind: 'failed',
      ...carry,
      ...acceptance,
      at,
      source,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(extra.assistantReason !== undefined ? { assistantReason: extra.assistantReason } : {}),
      ...(extra.providerOwnership !== undefined
        ? { providerOwnership: extra.providerOwnership }
        : {}),
    };
  }
  return {
    kind: 'cancelled',
    ...carry,
    ...acceptance,
    at,
    source,
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
  };
}

function deadlined(aggregate: SessionAggregate): Decision<SessionAggregate> {
  return { state: aggregate, commands: [], deadlineAt: sessionAlarmAt(aggregate) };
}

/**
 * Canonical allocation-loss terminalization without the incarnation fence: every
 * `queued`/`accepted` message becomes a coordinator `failed` carrying the loss
 * reason, and the binding clears. `decideSession`'s `STOPPED` branch fences first
 * and then applies exactly this; the stopped-seam adapter's proof-independent
 * settlement calls it directly so the row map has one owner, not two.
 */
export function terminalizeOnStop(
  aggregate: SessionAggregate,
  reason: string,
  now: number
): SessionAggregate {
  return {
    binding: { kind: 'unbound' },
    messages: aggregate.messages.map(message => {
      if (message.state.kind !== 'queued' && message.state.kind !== 'accepted') return message;
      const state = terminalMessageState(message.state, 'failed', now, 'coordinator', { reason });
      // Allocation loss is the single owner that clears the message's delivery
      // identity (deleting the spread's retained values), matching HEAD's
      // stop projection. The sibling cancellation marker is cleared too;
      // already-terminal messages are left untouched.
      delete state.wrapperInstanceId;
      delete state.preparationAttemptId;
      const { cancellation: _cancellation, ...rest } = message;
      return { ...rest, state };
    }),
  };
}

export function decideSession(
  aggregate: SessionAggregate,
  event: SessionEvent,
  now: number
): Decision<SessionAggregate> | undefined {
  switch (event.type) {
    case 'ENQUEUE': {
      if (find(aggregate, event.message.messageId)) return undefined;
      const next: SessionAggregate = {
        ...aggregate,
        messages: [...aggregate.messages, event.message],
      };
      return deadlined(next);
    }
    case 'BIND': {
      if (aggregate.binding.kind === 'bound') {
        const same =
          aggregate.binding.handle.incarnation === event.handle.incarnation &&
          aggregate.binding.handle.wrapper === event.handle.wrapper &&
          aggregate.binding.handle.epoch === event.handle.epoch;
        if (!same) return undefined;
        return deadlined(aggregate);
      }
      // `unbound` and legacy `unresolved` both resolve to the authoritative handle.
      const binding: Binding = { kind: 'bound', handle: event.handle };
      return deadlined({ ...aggregate, binding });
    }
    case 'UNBIND': {
      if (aggregate.binding.kind === 'unbound') return undefined;
      // Dropping the handle while accepted work may still be executing would
      // produce a state the canonical loader rejects and would lose the fence.
      if (aggregate.messages.some(message => message.state.kind === 'accepted')) return undefined;
      return deadlined({ ...aggregate, binding: { kind: 'unbound' } });
    }
    case 'DEMAND': {
      if (aggregate.binding.kind !== 'unbound') return undefined;
      return {
        state: aggregate,
        commands: [
          {
            kind: 'Acquire',
            operationId: operationId('acquire', event.requestId),
            requestId: event.requestId,
            deliveryDeadlineAt: event.deliveryDeadlineAt,
          },
        ],
        deadlineAt: sessionAlarmAt(aggregate),
      };
    }
    case 'ACCEPT': {
      if (aggregate.binding.kind !== 'bound') return undefined;
      if (headMessageId(aggregate) !== event.messageId) return undefined;
      const message = find(aggregate, event.messageId);
      if (!message || message.state.kind !== 'queued') return undefined;
      const wrapperInstanceId = event.wrapperInstanceId ?? aggregate.binding.handle.wrapper;
      // Acceptance always installs a bounded execution deadline and a recheck
      // anchor, so accepted work can never wait without a scheduled deadline.
      const executionDeadlineAt =
        event.executionDeadlineAt ?? event.acceptedAt + POLICY.acceptedExecutionBoundMs;
      const capAt = event.capAt ?? event.acceptedAt + POLICY.acceptedRecheckMs;
      const next = replace(aggregate, event.messageId, current => {
        if (current.state.kind !== 'queued') return current;
        return {
          ...current,
          state: {
            kind: 'accepted',
            ...carryFields(current.state),
            acceptedAt: event.acceptedAt,
            lastActivityAt: event.acceptedAt,
            wrapperInstanceId,
            executionDeadlineAt,
            capAt,
          },
        };
      });
      return deadlined(next);
    }
    case 'DELIVERY_STEP': {
      const message = find(aggregate, event.messageId);
      if (!message || message.state.kind !== 'queued') return undefined;
      const next = replace(aggregate, event.messageId, current => {
        if (current.state.kind !== 'queued') return current;
        return {
          ...current,
          state: {
            ...current.state,
            deliveryStep: event.step,
            ...(event.preparationAttemptId !== undefined
              ? { preparationAttemptId: event.preparationAttemptId }
              : {}),
            ...(event.preparationWait !== undefined
              ? { preparationWait: event.preparationWait }
              : {}),
            ...(event.retryNotBefore !== undefined ? { retryNotBefore: event.retryNotBefore } : {}),
          },
        };
      });
      return deadlined(next);
    }
    case 'RECORD_PROOF': {
      const message = find(aggregate, event.messageId);
      if (!message) return undefined;
      const next = replace(aggregate, event.messageId, current => ({
        ...current,
        proofs: mergeProofs(current.proofs, event.proofs),
      }));
      return deadlined(next);
    }
    case 'RECORD_CANCELLATION': {
      const message = find(aggregate, event.messageId);
      if (!message) return undefined;
      const next = replace(aggregate, event.messageId, current => ({
        ...current,
        cancellation: { operationId: event.operationId, deadlineAt: event.deadlineAt },
      }));
      return deadlined(next);
    }
    case 'OUTCOME': {
      const message = find(aggregate, event.messageId);
      if (!message || isTerminal(message.state)) return undefined;
      if (message.state.kind === 'queued' && headMessageId(aggregate) !== event.messageId) {
        return undefined;
      }
      const next = replace(aggregate, event.messageId, current => ({
        ...current,
        state: terminalMessageState(current.state, event.status, event.at, event.source, {
          reason: event.reason,
          detail: event.detail,
          result: event.result,
          assistantMessageId: event.assistantMessageId,
          gateResult: event.gateResult,
          assistantReason: event.assistantReason,
          providerOwnership: event.providerOwnership,
        }),
      }));
      return deadlined(next);
    }
    case 'CANCEL': {
      const message = find(aggregate, event.messageId);
      if (!message || isTerminal(message.state)) return undefined;
      if (message.state.kind === 'queued') {
        // Ambiguous with the agent: an unresolved dispatch or a dispatched prompt
        // must not be dropped as if it never ran. Record a bounded cancellation
        // intent and settle it on reconciliation or on the cancellation deadline.
        const ambiguous =
          message.state.unresolvedDispatch === true || message.proofs?.prompt?.dispatched === true;
        if (ambiguous) {
          const cancellation = {
            operationId: event.operationId ?? operationId('cancel', event.messageId, event.at),
            deadlineAt: event.deadlineAt ?? event.at + POLICY.cancellationDeadlineMs,
          };
          const next = replace(aggregate, event.messageId, current => ({
            ...current,
            cancellation,
          }));
          return deadlined(next);
        }
      }
      const next = replace(aggregate, event.messageId, current => ({
        ...current,
        state: terminalMessageState(current.state, 'cancelled', event.at, 'coordinator', {
          reason: event.reason ?? 'queued_message_cancelled',
        }),
      }));
      return deadlined(next);
    }
    case 'STOPPED': {
      // Incarnation-fence the loss: only a bound session whose handle matches the
      // proof may be terminalized. A duplicate or stale loss is rejected.
      if (aggregate.binding.kind !== 'bound') return undefined;
      const handle = aggregate.binding.handle;
      if (handle.incarnation !== event.proof.incarnation) return undefined;
      if (event.proof.wrapper !== undefined && event.proof.wrapper !== handle.wrapper) {
        return undefined;
      }
      return {
        state: terminalizeOnStop(aggregate, event.reason, now),
        commands: [],
        deadlineAt: null,
      };
    }
    case 'DEADLINE': {
      let changed = false;
      const messages = aggregate.messages.map(message => {
        if (message.state.kind === 'queued') {
          if (message.cancellation !== undefined && message.cancellation.deadlineAt <= now) {
            changed = true;
            // The dispatch stayed ambiguous, so do not claim execution stopped.
            return {
              ...message,
              state: terminalMessageState(message.state, 'failed', now, 'coordinator', {
                reason: 'cancellation_unconfirmed',
              }),
            };
          }
          const { deadlineAt, retryNotBefore } = message.state;
          if (deadlineAt !== null && deadlineAt <= now) {
            changed = true;
            return {
              ...message,
              state: terminalMessageState(message.state, 'failed', now, 'coordinator', {
                reason: 'delivery_deadline',
              }),
            };
          }
          if (retryNotBefore !== undefined && retryNotBefore <= now) {
            changed = true;
            const { retryNotBefore: _dropped, ...rest } = message.state;
            return { ...message, state: rest };
          }
          return message;
        }
        if (message.state.kind === 'accepted') {
          if (message.cancellation !== undefined && message.cancellation.deadlineAt <= now) {
            changed = true;
            return {
              ...message,
              state: terminalMessageState(message.state, 'failed', now, 'coordinator', {
                reason: 'cancellation_unconfirmed',
              }),
            };
          }
          if (message.state.executionDeadlineAt <= now) {
            changed = true;
            return {
              ...message,
              state: terminalMessageState(message.state, 'failed', now, 'coordinator', {
                reason: 'execution_deadline',
              }),
            };
          }
          if (message.state.capAt !== undefined && message.state.capAt <= now) {
            changed = true;
            // Recheck cadence; the execution bound remains the hard deadline.
            return {
              ...message,
              state: { ...message.state, capAt: now + POLICY.acceptedRecheckMs },
            };
          }
          return message;
        }
        return message;
      });
      if (!changed) return deadlined(aggregate);
      return deadlined({ ...aggregate, messages });
    }
  }
}

function mergeProofs(current: MessageProofs | undefined, incoming: MessageProofs): MessageProofs {
  const merged: MessageProofs = { ...current };
  if (incoming.attach !== undefined) merged.attach = incoming.attach;
  if (incoming.retiredAttach !== undefined) merged.retiredAttach = incoming.retiredAttach;
  if (incoming.prompt !== undefined) merged.prompt = incoming.prompt;
  return merged;
}
