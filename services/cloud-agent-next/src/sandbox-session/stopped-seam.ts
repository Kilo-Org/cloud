/**
 * Pure stopped-seam adapter for the allocation→session `STOPPED` event. It takes
 * the canonical messages already decoded by the storage boundary and derives the
 * binding from the authoritative attachment record (never from message states).
 *
 * The terminalization decision is never re-derived here. The fenced operation
 * takes the canonical decided messages from `decideSession`; the proof-independent
 * settlement calls the canonical `terminalizeOnStop` directly. Because the input
 * is canonical, the seam does no decoding and performs no representation mapping.
 *
 * It does no I/O and holds no storage. It must not import `persist/legacy/`
 * (quarantine) and must not derive the binding with `convertLegacySession(rows,
 * handle)`, which marks a queued-only or idle-but-attached session `unbound`.
 */
import { decideSession, terminalizeOnStop } from '../sandbox-state/session/reduce.js';
import type { StoppedEvent } from '../sandbox-state/events.js';
import type { SessionMessage } from '../sandbox-state/model/session.js';
import { bindingForAttachment, type StoppedAttachment } from './session-binding.js';

export type { StoppedAttachment };

/** Binding keys the caller clears when the decision terminalizes. */
export type StoppedClearKey = 'attachment' | 'nativeRuntimeFence';

export type StoppedSeamResult =
  | { outcome: 'rejected' }
  | {
      outcome: 'terminalized';
      messages: readonly SessionMessage[];
      clear: readonly StoppedClearKey[];
    };

export type StoppedSettlementResult =
  | { outcome: 'rejected' }
  | { outcome: 'settled'; messages: readonly SessionMessage[]; clear: readonly StoppedClearKey[] };

/**
 * Fenced decision for a matching `STOPPED`. An unfenceable binding
 * (`unresolved`/`unbound`) or a stale proof returns `rejected`; a duplicate is
 * rejected because the binding has already been cleared.
 */
export function decideStopped(input: {
  messages: readonly SessionMessage[];
  attachment: StoppedAttachment | undefined;
  event: StoppedEvent;
  now: number;
}): StoppedSeamResult {
  const { messages, attachment, event, now } = input;
  const decision = decideSession(
    { binding: bindingForAttachment(attachment, messages), messages: [...messages] },
    event,
    now
  );
  if (decision === undefined) return { outcome: 'rejected' };
  return {
    outcome: 'terminalized',
    messages: decision.state.messages,
    clear: ['attachment', 'nativeRuntimeFence'],
  };
}

/**
 * Proof-independent settlement (item 4's settle outcome): terminalize every
 * `queued`/`accepted` message with the loss reason through the canonical
 * operation, without the incarnation fence.
 */
export function settleStopped(input: {
  messages: readonly SessionMessage[];
  reason: string;
  now: number;
}): StoppedSettlementResult {
  const settled = terminalizeOnStop(
    { binding: { kind: 'unbound' }, messages: [...input.messages] },
    input.reason,
    input.now
  );
  return {
    outcome: 'settled',
    messages: settled.messages,
    clear: ['attachment', 'nativeRuntimeFence'],
  };
}
