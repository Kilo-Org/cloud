import { sessionIdSchema } from '@kilocode/session-ingest-contracts';

/**
 * The shape a real Kilo session id can take, derived from the shared contract
 * (`sessionIdSchema` in `@kilocode/session-ingest-contracts`: `ses_` + 26
 * alphanumeric characters) instead of re-declaring it, so this guard and the
 * server contract cannot drift. The agent-chat route's `session-id` param,
 * by contrast, accepts any non-empty string: a malformed or hand-built deep
 * link can deliver a segment that can never resolve to a session (an
 * all-zeros UUID was observed in the wild). Such an id is rejected here so the
 * route never mounts a session screen that can only end in "Not found".
 */
export function isPlausibleKiloSessionId(value: string): boolean {
  return sessionIdSchema.safeParse(value).success;
}
