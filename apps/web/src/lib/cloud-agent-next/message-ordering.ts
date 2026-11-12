import type { MessageInfo } from '@kilocode/cloud-agent-sdk';
import { orderMessageIds } from '@kilocode/cloud-agent-sdk/storage/helpers';

type IdentifiedSessionMessage = {
  info: { id: string };
  parts: Array<{ id: string }>;
};

/**
 * Message display ordering for V2 (StoredMessage-shaped) sessions.
 *
 * The session-ingest export endpoint streams messages and parts in ingest
 * order (`ingested_at, id`), which can differ from conversation order when a
 * session is re-ingested or history arrives out of order. Read-only views that
 * render the raw export (the admin session trace viewer and the public
 * shared-session page) apply the same turn order as the cloud-agent-next
 * transcript (`orderMessageIds` in `@kilocode/cloud-agent-sdk`), so they match
 * what users see. Parts keep their time-ordered id order, as in SDK storage.
 *
 * Messages are sorted by id first: that is the order `orderMessageIds` keeps
 * when a row has no readable time.
 */
export function sortSessionMessagesForDisplay<T extends IdentifiedSessionMessage>(
  messages: T[]
): T[] {
  const byIdAscending = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  const sorted = messages
    .map(message => ({ ...message, parts: [...message.parts].sort(byIdAscending) }))
    .sort((a, b) => byIdAscending(a.info, b.info));
  const byId = new Map(sorted.map(message => [message.info.id, message]));
  if (byId.size !== sorted.length) return sorted;

  // Export rows are unvalidated; `orderMessageIds` reads every field it uses
  // defensively and keeps the id order for a row it cannot place.
  const infos = new Map(
    sorted.map(message => [message.info.id, message.info as unknown as MessageInfo])
  );
  return orderMessageIds(
    sorted.map(message => message.info.id),
    infos
  ).flatMap(id => byId.get(id) ?? []);
}
