import { type CloudAgentSessionId } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

/**
 * A Cloud Agent session id: any non-blank string. The platform issues
 * `agent_`/`workspace_` shapes, but stored rows predate them, so only the
 * presence of an id is required here.
 */
const CLOUD_AGENT_SESSION_ID_SCHEMA = z.string().trim().min(1);

/** An organization id: the UUID every organization procedure validates. */
const ORGANIZATION_SCOPE_SCHEMA = z.uuid();

/**
 * The Cloud Agent session id a stored row or route carries, or `null` when it
 * carries none. `cliSessionsV2` types the column as `string | null`, but the
 * app also replays rows it persisted under an earlier schema and reads route
 * params from hand-built links, where the value can be absent or blank. Every
 * cloud-only request keys off "there is an id", so a blank one must read as
 * "not a Cloud Agent session" instead of becoming a request the server refuses
 * as invalid input — a permanent failure no retry can fix.
 */
export function parseCloudAgentSessionId(value: unknown): CloudAgentSessionId | null {
  const parsed = CLOUD_AGENT_SESSION_ID_SCHEMA.safeParse(value);
  return parsed.success ? (parsed.data as CloudAgentSessionId) : null;
}

/**
 * The organization a session is read through, or `undefined` for the personal
 * scope. Every organization procedure validates `organizationId` as a UUID, so
 * a value of any other shape — a route param from a hand-built link, or an id a
 * persisted row outlived — must read as "no organization scope". Forwarding it
 * would answer `BAD_REQUEST` on every request, and no retry can fix that.
 */
export function parseOrganizationScope(value: unknown): string | undefined {
  const parsed = ORGANIZATION_SCOPE_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
