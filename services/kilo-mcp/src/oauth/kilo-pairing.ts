/**
 * Trusted apps/web calls for the library-backed OAuth flow (s3).
 *
 * The worker has no user session of its own: apps/web stays the user-identity
 * provider. This module owns the two device-auth calls plus the organization
 * list read:
 *
 * - `createKiloPairing` opens a pairing (`POST /api/device-auth/codes`).
 * - `pollKiloPairing` relays one pairing-status question
 *   (`GET /api/device-auth/codes/{code}`).
 * - `fetchOrgOptions` lists the paired identity's organizations by calling the
 *   read-only `organizations.list` catalog query with the Kilo bearer.
 *
 * Moved from src/auth/authorize.ts (createKiloPairing) and
 * src/oauth-pages/authorize-page.ts (pollKiloPairing) plus the org-picker
 * list read, so the new defaultHandler routes own their I/O.
 *
 * Trust boundary: apps/web responses are trusted and never zod-validated.
 * Only the UNTRUSTED request headers forwarded upstream are validated, with
 * `forwardedClientHeadersSchema`.
 */
import { forwardedClientHeadersSchema } from '../schemas';
import { PERSONAL_ORG_ID, type OrgOption } from './pages';

export type KiloPairingDeps = {
  /** apps/web base URL — the user-identity provider. */
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
};

/** Header names the worker forwards to apps/web, all lowercase to match Fetch. */
type ForwardedHeaderName = 'cf-connecting-ip' | 'x-forwarded-for' | 'user-agent';

/**
 * Forward one client header only when it passes `forwardedClientHeadersSchema`
 * (bounded length, no CR/LF). Validating per header keeps a malformed value
 * (e.g. an oversized user-agent) from also stripping the Cloudflare-set IP
 * that apps/web rate-limits pending pairings by.
 */
function forwardedHeader(request: Request, name: ForwardedHeaderName): string | undefined {
  const value = request.headers.get(name);
  if (value === null) return undefined;
  const parsed = forwardedClientHeadersSchema.safeParse({ [name]: value });
  return parsed.success ? parsed.data[name] : undefined;
}

export type KiloPairingFailure = 'rate_limited' | 'unreachable';

/**
 * Create the Kilo device-auth pairing on apps/web
 * (`POST /api/device-auth/codes`, apps/web/src/app/api/device-auth/codes/route.ts).
 * apps/web rate-limits pending pairings per IP and requires the client IP in
 * production, so the incoming request's IP and user-agent are forwarded.
 */
export async function createKiloPairing(
  deps: KiloPairingDeps,
  request: Request
): Promise<{ ok: true; pairingCode: string } | { ok: false; kind: KiloPairingFailure }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.webBaseUrl.replace(/\/$/, '')}/api/device-auth/codes`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const clientIp =
    forwardedHeader(request, 'cf-connecting-ip') ?? forwardedHeader(request, 'x-forwarded-for');
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  const userAgent = forwardedHeader(request, 'user-agent');
  if (userAgent) headers['user-agent'] = userAgent;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: '{}' });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (response.status === 429) return { ok: false, kind: 'rate_limited' };
  if (!response.ok) return { ok: false, kind: 'unreachable' };

  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, kind: 'unreachable' };
  }
  return { ok: true, pairingCode: code };
}

export type KiloPollOutcome =
  | { status: 'pending' }
  | { status: 'approved'; token: string; userId: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'unreachable' };

/**
 * Relay one pairing-status question to apps/web
 * (`GET /api/device-auth/codes/{code}` — statuses pending/approved/denied/
 * expired, apps/web/src/app/api/device-auth/codes/[code]/route.ts). Any
 * transport-level or shape surprise is `unreachable`: the caller keeps the
 * user waiting and lets the next poll retry rather than failing the flow.
 */
export async function pollKiloPairing(
  deps: Pick<KiloPairingDeps, 'webBaseUrl' | 'fetchImpl'>,
  deviceAuthCode: string
): Promise<KiloPollOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.webBaseUrl.replace(/\/$/, '')}/api/device-auth/codes/${encodeURIComponent(deviceAuthCode)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch {
    return { status: 'unreachable' };
  }
  if (response.status === 202) return { status: 'pending' };
  if (response.status === 403) return { status: 'denied' };
  if (response.status === 410) return { status: 'expired' };
  if (!response.ok) return { status: 'unreachable' };
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return { status: 'unreachable' };
  const record = body as { status?: unknown; token?: unknown; userId?: unknown };
  if (record.status !== 'approved') return { status: 'unreachable' };
  if (typeof record.token !== 'string' || record.token.length === 0)
    return { status: 'unreachable' };
  if (typeof record.userId !== 'string' || record.userId.length === 0)
    return { status: 'unreachable' };
  return { status: 'approved', token: record.token, userId: record.userId };
}

/** The catalog query used to list the caller's orgs (read-only, in the dump). */
export const ORG_LIST_QUERY_PATH = 'organizations.list';

/**
 * Fetch the Kilo identity's organizations by calling the catalog tRPC query
 * with the approved Kilo bearer. Returns the selectable options with the
 * personal context first (an approved Kilo login always has it, so the picker
 * is never empty). Throws on any upstream failure — the caller renders a
 * retryable error.
 */
export async function fetchOrgOptions(
  deps: Pick<KiloPairingDeps, 'webBaseUrl' | 'fetchImpl'>,
  kiloToken: string
): Promise<OrgOption[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(`/api/trpc/${ORG_LIST_QUERY_PATH}`, deps.webBaseUrl);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${kiloToken}` },
    });
  } catch {
    throw new Error('org list upstream unreachable');
  }
  if (!response.ok) {
    throw new Error(`org list upstream returned ${response.status}`);
  }
  // apps/web responses are trusted: read the tRPC envelope without zod.
  const body: unknown = await response.json().catch(() => null);
  const data = (body as { result?: { data?: unknown } } | null)?.result?.data;
  if (!Array.isArray(data)) {
    throw new Error('org list upstream returned an unexpected shape');
  }
  const options: OrgOption[] = [{ id: PERSONAL_ORG_ID, name: 'Personal account' }];
  const seen = new Set<string>([PERSONAL_ORG_ID]);
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const id = (row as { organizationId?: unknown }).organizationId;
    const name = (row as { organizationName?: unknown }).organizationName;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, name: typeof name === 'string' && name.length > 0 ? name : id });
  }
  return options;
}
