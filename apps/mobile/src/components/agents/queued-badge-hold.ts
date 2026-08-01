import { type MessageDeliveryState } from '@kilocode/cloud-agent-sdk';

/**
 * Returns the next held-queued-id set given the previous set, the current
 * pending-messages map, and the streaming flag.
 *
 * Semantics:
 * - When `isStreaming` is false, returns a shared EMPTY set (stream end
 *   releases every held id — one-shot per stream).
 * - While streaming, the set never shrinks: every id in `prev` stays, and
 *   every `pendingMessages` key whose entry has `status === 'queued'` is
 *   also added.
 * - Returns the identical `prev` reference when nothing would change.
 *   Required for the parent's render-phase state adjustment to converge;
 *   a fresh set every call would cause an infinite render loop.
 */
export function nextHeldQueuedIds(
  prev: ReadonlySet<string>,
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>,
  isStreaming: boolean
): ReadonlySet<string> {
  if (!isStreaming) {
    return EMPTY_IDS;
  }

  let next: Set<string> | null = null;

  // Add every queued id we don't yet hold.
  for (const [id, state] of pendingMessages) {
    if (state.status === 'queued' && !prev.has(id)) {
      next ??= new Set(prev);
      next.add(id);
    }
  }

  return next ?? prev;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
