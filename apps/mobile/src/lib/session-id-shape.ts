/**
 * The shape a real Kilo session id can take.
 *
 * Every legitimate id is produced server-side as `ses_` + 26 alphanumeric
 * characters (`sessionIdSchema` in `@kilocode/session-ingest-contracts`:
 * `z.string().startsWith('ses_').length(30)`), and every create path enforces
 * that shape before a session can exist. The agent-chat route's `session-id`
 * param, by contrast, accepts any non-empty string: a malformed or hand-built
 * deep link can deliver a segment that can never resolve to a session (an
 * all-zeros UUID was observed in the wild). Such an id is rejected here so the
 * route never mounts a session screen that can only end in "Not found".
 */
export function isPlausibleKiloSessionId(value: string): boolean {
  return value.startsWith('ses_') && value.length === 30;
}
