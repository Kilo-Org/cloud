/**
 * The consent page served at GET /authorize (s6, continuing s5's record) and
 * the worker endpoint that page polls for pairing completion.
 *
 * apps/web stays the identity provider: the page's Continue button opens
 * `{WEB_BASE_URL}/device-auth?code=<pairingCode>` (the existing Kilo sign-in +
 * approval page — zero changes to apps/web), and this endpoint relays the
 * pairing outcome the page polls for. The upstream poll
 * (apps/web/src/app/api/device-auth/codes/[code]/route.ts) is SINGLE-USE:
 * its first `approved` answer consumes the pairing and mints the Kilo token,
 * so the token + userId are persisted via `recordPairingApproval` the moment
 * they are seen and the endpoint never asks apps/web twice for one pairing.
 *
 * Once the pairing is approved the user still has to pick an organization, so
 * the page is pointed at the org picker (`needs_org`); after the org is bound
 * the record is `approved` and the page follows the client redirect.
 *
 * States: pending -> keep waiting; needs_org -> redirect to the picker;
 * denied / expired / unknown -> failure copy + a restart link that re-runs the
 * exact original /authorize request (fresh pairing). Upstream hiccups
 * (`unreachable`) keep the page waiting — the next poll retries.
 */
import {
  authJsonResponse,
  authPage,
  escapeHtml,
  htmlResponse,
  PAIRING_POLL_INTERVAL_MS,
} from '../auth/http';
import type { McpAnalytics } from '../analytics';
import type { OAuthStoreApi } from '../store/oauth-store';

export type PairingStatusDeps = {
  store: OAuthStoreApi;
  /** apps/web base URL — polled for the device-auth pairing outcome. */
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Best-effort sign-in analytics; never awaited and never allowed to throw. */
  analytics?: McpAnalytics;
};

/**
 * The consent HTML: sign-in link + status polling until the flow resolves.
 *
 * The sign-in link opens in a NEW TAB on purpose: the pairing-status poll runs
 * in this tab, so sending the user to apps/web in the same tab killed the poll
 * (the page had to be reopened from the MCP client). A background tab keeps
 * polling; the browser may throttle it while hidden, and it catches up when
 * this tab regains focus.
 */
export function consentPage(input: {
  clientName: string;
  scope: string;
  webSignInUrl: string;
  statusUrl: string;
  /** The original /authorize URL; the failure states offer to restart from it. */
  restartUrl: string;
}): Response {
  const body =
    `<h1>Connect to Kilo MCP</h1>` +
    `<p><strong>${escapeHtml(input.clientName)}</strong> is asking to connect to Kilo MCP ` +
    `with your Kilo account.</p>` +
    `<p>Requested access: <code>${escapeHtml(input.scope)}</code></p>` +
    `<a class="cta" href="${escapeHtml(input.webSignInUrl)}" target="_blank" ` +
    `rel="noopener noreferrer">Continue with Kilo sign-in</a>` +
    `<p id="status" role="status">Waiting for you to finish sign-in&hellip;</p>` +
    `<a id="restart" class="secondary" href="${escapeHtml(input.restartUrl)}" hidden>` +
    `Start sign-in again</a>` +
    `<script>(function(){var u=${JSON.stringify(input.statusUrl)};var el=document.getElementById('status');` +
    `var restart=document.getElementById('restart');` +
    `function fail(msg){el.textContent=msg;restart.hidden=false;}` +
    `async function poll(){try{var r=await fetch(u,{credentials:'omit'});var j=await r.json();` +
    `if(j.status==='approved'){location.replace(j.redirect_url);return;}` +
    `if(j.status==='needs_org'){location.replace(j.picker_url);return;}` +
    `if(j.status==='denied'){fail('Kilo sign-in was denied. Start sign-in again to retry, or close this tab.');return;}` +
    `if(j.status==='expired'){fail('The Kilo sign-in request expired. Start sign-in again to try once more.');return;}` +
    `if(j.status==='unknown'){fail('This request is no longer valid. Start sign-in again, or close this tab and retry from your MCP client.');return;}}` +
    `catch(e){}setTimeout(poll,${PAIRING_POLL_INTERVAL_MS});}poll();})();</script>`;
  return htmlResponse(authPage('Connect to Kilo MCP', body));
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
  deps: Pick<PairingStatusDeps, 'webBaseUrl' | 'fetchImpl'>,
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

export type PairingStatus =
  | { status: 'pending' }
  | { status: 'needs_org'; picker_url: string }
  | { status: 'approved'; redirect_url: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'unknown' };

function needsOrg(code: string): Response {
  return authJsonResponse({
    status: 'needs_org',
    picker_url: `/authorize/org?code=${encodeURIComponent(code)}`,
  } satisfies PairingStatus);
}

function clientRedirect(record: {
  redirectUri: string;
  code: string;
  state: string | null;
}): Response {
  const redirect = new URL(record.redirectUri);
  redirect.searchParams.set('code', record.code);
  if (record.state) redirect.searchParams.set('state', record.state);
  return authJsonResponse({
    status: 'approved',
    redirect_url: redirect.toString(),
  } satisfies PairingStatus);
}

/**
 * GET /authorize/status?code=<code> — what the consent page polls. Unknown,
 * expired, and already-redeemed codes answer identically so the endpoint
 * cannot be used to probe which pairing codes exist. While the record is
 * pending this endpoint drives the apps/web relay; a denial is persisted so
 * the token endpoint reports it too.
 */
export async function handlePairingStatus(
  request: Request,
  deps: PairingStatusDeps
): Promise<Response> {
  if (request.method !== 'GET') {
    return authJsonResponse({ error: 'invalid_request' }, 405);
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
  }
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const record = await deps.store.getCode(code);
  if (!record || record.expiresAt <= nowIso || record.status === 'used') {
    return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
  }
  if (record.status === 'denied') {
    // Terminal state, and the transition already recorded the failure once
    // (`denyCode` is only ever called just before that emit). A later poll of
    // the same record must answer denied without re-emitting.
    return authJsonResponse({ status: 'denied' } satisfies PairingStatus);
  }
  if (record.status === 'approved') {
    return clientRedirect(record);
  }
  // status 'pending': pairing approved upstream but not recorded yet?
  if (record.kiloUserId && record.kiloToken) {
    return needsOrg(code);
  }

  const upstream = await pollKiloPairing(deps, record.deviceAuthCode);
  switch (upstream.status) {
    case 'pending':
    case 'unreachable':
      // Transient upstream failure keeps the page waiting; its next poll retries.
      return authJsonResponse({ status: 'pending' } satisfies PairingStatus);
    case 'denied': {
      await deps.store.denyCode(record.deviceAuthCode, nowIso);
      deps.analytics?.oauthSignIn({
        phase: 'failed',
        identity: null,
        clientId: record.clientId,
        reason: 'denied',
      });
      return authJsonResponse({ status: 'denied' } satisfies PairingStatus);
    }
    case 'expired':
      deps.analytics?.oauthSignIn({
        phase: 'failed',
        identity: null,
        clientId: record.clientId,
        reason: 'expired',
      });
      return authJsonResponse({ status: 'expired' } satisfies PairingStatus);
    case 'approved': {
      // Persist BEFORE any further poll: the upstream answer is single-use.
      await deps.store.recordPairingApproval(
        record.deviceAuthCode,
        { kiloUserId: upstream.userId, kiloToken: upstream.token },
        nowIso
      );
      const updated = await deps.store.getCode(code);
      if (updated?.kiloUserId && updated.kiloToken) {
        return needsOrg(code);
      }
      // The record moved to a terminal state while we polled.
      if (updated?.status === 'approved') return clientRedirect(updated);
      if (updated?.status === 'denied') {
        return authJsonResponse({ status: 'denied' } satisfies PairingStatus);
      }
      return authJsonResponse({ status: 'unknown' } satisfies PairingStatus);
    }
  }
}
