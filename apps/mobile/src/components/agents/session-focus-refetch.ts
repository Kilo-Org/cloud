/**
 * Decides whether a session focus must refetch its linked-PR metadata.
 *
 * The first focus on a session id is owned by `manager.switchSession`, which
 * already fetches the session (including `associatedPr`) and writes it into
 * `fetchedSessionDataAtom`. Every later focus on the same id must refetch so a
 * link, unlink, or mid-session decision change surfaces without reopening the
 * session.
 */
export function shouldRefetchOnFocus(seededSessionId: string | null, sessionId: string): boolean {
  return seededSessionId === sessionId;
}
