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
 * - `fetchUserIsAdmin` answers whether the paired identity is a platform admin
 *   by calling the read-only `user.getMe` catalog query with the same bearer.
 *
 * This module now owns the pairing I/O that the hand-rolled authorization
 * endpoint and consent page used to do, so the new defaultHandler routes own
 * their own I/O.
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

export type KiloPairingFailure = 'rate_limited' | 'unreachable' | 'client_unconfirmed';

/**
 * The OAuth client a pairing asks about, as the approval page presents it and
 * the approved pairing echoes it back. The worker accepts an approval only for
 * this exact client and redirect origin.
 */
export type RequestingClient = {
  clientId: string;
  /** Display name; an absent or unusable name becomes a neutral label. */
  clientName?: string;
  /** Origin (or app scheme) the approved code is delivered to. */
  redirectOrigin: string;
};

/** Longest client name the approval page renders (`REQUESTING_CLIENT_FIELD_MAX`). */
const CLIENT_NAME_MAX = 200;

/** The label a client without a usable name shows as. */
const UNNAMED_CLIENT = 'Unnamed application';

/**
 * The origin the approved code is delivered to. http(s) URIs yield their
 * origin; any other scheme yields `scheme://host` (or the bare scheme), because
 * `URL.origin` is `null` for a non-special scheme. `null` means the redirect
 * URI is not an absolute URL, so no client identity can be presented for it.
 * The path and query never appear: the approver only needs to know where the
 * code goes, and a path is not a trust boundary.
 */
export function redirectOriginOf(redirectUri: string): string | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  return url.host.length > 0 ? `${url.protocol}//${url.host}` : url.protocol;
}

/** One displayable line from a client-supplied name: no control characters, bounded. */
function displayClientName(name: string | undefined): string {
  const collapsed = (name ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bounded = collapsed.slice(0, CLIENT_NAME_MAX).trim();
  return bounded.length > 0 ? bounded : UNNAMED_CLIENT;
}

/** The `requesting_client` member apps/web stores and echoes for a pairing. */
function requestingClientPayload(client: RequestingClient): {
  client_id: string;
  client_name: string;
  redirect_origin: string;
} {
  return {
    client_id: client.clientId,
    client_name: displayClientName(client.clientName),
    redirect_origin: client.redirectOrigin,
  };
}

/**
 * Read the requesting client an apps/web answer carries. A shape this worker
 * cannot act on is `null`, never a guess: every approval is compared field by
 * field before a grant is minted.
 */
function readRequestingClient(value: unknown): RequestingClient | null {
  if (typeof value !== 'object' || value === null) return null;
  const clientId = 'clientId' in value ? value.clientId : undefined;
  const clientName = 'clientName' in value ? value.clientName : undefined;
  const redirectOrigin = 'redirectOrigin' in value ? value.redirectOrigin : undefined;
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    typeof clientName !== 'string' ||
    clientName.length === 0 ||
    typeof redirectOrigin !== 'string' ||
    redirectOrigin.length === 0
  ) {
    return null;
  }
  return { clientId, clientName, redirectOrigin };
}

/**
 * Create the Kilo device-auth pairing on apps/web
 * (`POST /api/device-auth/codes`, apps/web/src/app/api/device-auth/codes/route.ts).
 * apps/web rate-limits pending pairings per IP and requires the client IP in
 * production, so the incoming request's IP and user-agent are forwarded.
 *
 * The request names the OAuth client it is asking about, and the answer echoes
 * the client apps/web stored. An answer that does not echo this client cannot
 * be approved against it later, so it is a retryable failure now instead of a
 * sign-in that can never finish.
 */
export async function createKiloPairing(
  deps: KiloPairingDeps,
  request: Request,
  client: RequestingClient
): Promise<
  | { ok: true; pairingCode: string; requestingClient: RequestingClient }
  | { ok: false; kind: KiloPairingFailure }
> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.webBaseUrl.replace(/\/$/, '')}/api/device-auth/codes`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const clientIp =
    forwardedHeader(request, 'cf-connecting-ip') ?? forwardedHeader(request, 'x-forwarded-for');
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  const userAgent = forwardedHeader(request, 'user-agent');
  if (userAgent) headers['user-agent'] = userAgent;

  const body = JSON.stringify({ requesting_client: requestingClientPayload(client) });

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (response.status === 429) return { ok: false, kind: 'rate_limited' };
  if (!response.ok) return { ok: false, kind: 'unreachable' };

  const answer: unknown = await response.json().catch(() => null);
  if (typeof answer !== 'object' || answer === null) {
    return { ok: false, kind: 'unreachable' };
  }
  const code = 'code' in answer ? answer.code : undefined;
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, kind: 'unreachable' };
  }
  const echoed = readRequestingClient(
    'requestingClient' in answer ? answer.requestingClient : null
  );
  if (echoed === null || echoed.clientId !== client.clientId) {
    return { ok: false, kind: 'client_unconfirmed' };
  }
  return { ok: true, pairingCode: code, requestingClient: echoed };
}

export type KiloPollOutcome =
  | { status: 'pending' }
  | {
      status: 'approved';
      token: string;
      userId: string;
      /** The client the approved pairing names, when apps/web reports one. */
      requestingClient: RequestingClient | null;
      /** Whether the approver confirmed that exact client. */
      clientConfirmed: boolean;
    }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'unreachable' };

/**
 * Relay one pairing-status question to apps/web
 * (`GET /api/device-auth/codes/{code}` — statuses pending/approved/denied/
 * expired, apps/web/src/app/api/device-auth/codes/[code]/route.ts). Any
 * transport-level or shape surprise is `unreachable`: the caller keeps the
 * user waiting and lets the next poll retry rather than failing the flow. An
 * approval is never `unreachable` for a missing client description: it is an
 * approval this worker will refuse to complete.
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
  const status = 'status' in body ? body.status : undefined;
  const token = 'token' in body ? body.token : undefined;
  const userId = 'userId' in body ? body.userId : undefined;
  if (status !== 'approved') return { status: 'unreachable' };
  if (typeof token !== 'string' || token.length === 0) return { status: 'unreachable' };
  if (typeof userId !== 'string' || userId.length === 0) return { status: 'unreachable' };
  return {
    status: 'approved',
    token,
    userId,
    requestingClient: readRequestingClient(
      'requestingClient' in body ? body.requestingClient : null
    ),
    clientConfirmed: ('clientConfirmed' in body ? body.clientConfirmed : undefined) === true,
  };
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

/** The catalog query that answers whether the caller is a platform admin (s2). */
export const USER_ME_QUERY_PATH = 'user.getMe';

/**
 * Answer whether the paired Kilo identity is a platform admin by calling the
 * catalog `user.getMe` query with the approved Kilo bearer. Unlike
 * `pollKiloPairing` this THROWS on any upstream failure (transport error or
 * non-ok status) instead of folding it into a false answer: the picker has to
 * tell 'not an admin' (a valid `false`) apart from 'could not check' (an error),
 * because only the latter raises the reload notice — and both stay fail-closed.
 * apps/web responses are trusted, so the envelope is read without zod and only
 * an explicit `true` counts as admin (missing/mistyped ⇒ false).
 */
export async function fetchUserIsAdmin(
  deps: Pick<KiloPairingDeps, 'webBaseUrl' | 'fetchImpl'>,
  kiloToken: string
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(`/api/trpc/${USER_ME_QUERY_PATH}`, deps.webBaseUrl);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${kiloToken}` },
    });
  } catch {
    throw new Error('user.getMe upstream unreachable');
  }
  if (!response.ok) {
    throw new Error(`user.getMe upstream returned ${response.status}`);
  }
  // apps/web responses are trusted: read the tRPC envelope without zod.
  const body: unknown = await response.json().catch(() => null);
  const data = (body as { result?: { data?: unknown } } | null)?.result?.data;
  return (data as { isAdmin?: unknown } | null)?.isAdmin === true;
}
