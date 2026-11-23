import { whenSessionAttentionHydrationSettled } from '@/lib/session-attention';

/**
 * How long a glanceable derive waits for the session-attention ack store to
 * hydrate before deriving. The store answers "not acked" for every raise while
 * it loads, so a derive that beats it would republish a raise the person
 * already answered. A fresh background process (periodic refresh, wake, or a
 * widget press) opens the encrypted KV on this run, so the wait is a cold KV
 * open, not a network read: a couple of seconds covers it while keeping the
 * derive well inside the OS budget, and a store that never settles still
 * derives — an unhydrated read is the same answer every surface had before
 * this wait existed.
 */
const ACK_HYDRATION_SETTLE_MS = 2000;

/**
 * Wait (bounded) for the ack store's hydration read. Every glanceable path
 * that resolves raises into counts arms this before it derives: this process
 * did not necessarily answer the raise, so before hydrating the store reads
 * every raise the last run answered as unanswered.
 */
export function whenGlanceableAckHydrationSettled(): Promise<void> {
  return whenSessionAttentionHydrationSettled(ACK_HYDRATION_SETTLE_MS);
}
