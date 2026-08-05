import type { SessionMessage } from '@/lib/session-ingest-client';

/**
 * Message display ordering for V2 (StoredMessage-shaped) sessions.
 *
 * The session-ingest export endpoint streams messages and parts in ingest
 * order (`ingested_at, id`), which can differ from conversation order when a
 * session is re-ingested or history arrives out of order. The cloud-agent-next
 * UI re-establishes display order by inserting each message/part into storage
 * sorted by its time-ordered ID (`insertSorted` / `insertPartSorted` in
 * `@kilocode/cloud-agent-sdk` storage). Message and part IDs are
 * `msg_`/`part_` + big-endian hex timestamp + random suffix, so plain
 * lexicographic ordering matches chronological order.
 *
 * Read-only views that render the raw export (e.g. the admin session trace
 * viewer) must apply the same ordering to match what users see.
 */
export function sortSessionMessagesForDisplay(messages: SessionMessage[]): SessionMessage[] {
  const byIdAscending = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  return messages
    .map(message => ({ ...message, parts: [...message.parts].sort(byIdAscending) }))
    .sort((a, b) => byIdAscending(a.info, b.info));
}
