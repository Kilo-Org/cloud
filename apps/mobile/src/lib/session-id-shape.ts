import { storedSessionIdSchema } from '@kilocode/session-ingest-contracts';

/**
 * Whether a `session-id` param can address a session the store holds. The store
 * keeps sessions created before the canonical shape was issued — an older
 * editor session keeps the id it was created with, and its stored transcript is
 * read by that id — so the detail route must not decide from the canonical
 * pattern alone that a param can never be a session. The metadata read answers
 * that, and its denial is what the route shows.
 *
 * Same rule as the session-ingest read path (`storedSessionIdSchema`), so the
 * route never starts a read the server would refuse as malformed.
 */
export function isAddressableStoredSessionId(value: string): boolean {
  return storedSessionIdSchema.safeParse(value).success;
}
