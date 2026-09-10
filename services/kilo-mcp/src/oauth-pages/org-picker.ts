/**
 * The org picker served at GET/POST /authorize/org (s6).
 *
 * Reached once the consent page's poll reports `needs_org`: the device-auth
 * pairing is approved and this worker already holds the approved Kilo token +
 * userId (recordPairingApproval persisted them). The picker asks apps/web
 * which organizations that Kilo identity belongs to — by calling the
 * read-only `organizations.list` catalog query with the Kilo bearer — renders
 * them (plus the personal, org-less context), and on selection completes the
 * MCP authorization: binds the chosen org into the pending code and redirects
 * to the client's redirect_uri with the authorization code.
 *
 * The org choice is stored with the authorization (approveCode) and lands in
 * the token claims (token.ts reads the consumed record's organizationId),
 * which is what requirement 17/18 asks for: the token is bound to
 * user + org + this MCP.
 *
 * Trust boundary: a concrete organizationId submitted by the form is validated
 * against the freshly-fetched membership list — a client cannot authorize an
 * org it is not a member of by editing the form. The personal context needs no
 * such check: it authorizes the already-paired Kilo user with no org, so the
 * submit must complete even when the membership read is down.
 */
import { consentPage } from './authorize-page';
import {
  AUTH_PATHS,
  authPage,
  escapeHtml,
  errorPage,
  htmlResponse,
  withAuthCors,
} from '../auth/http';
import type { OAuthCodeRecord, OAuthStoreApi } from '../store/oauth-store';

export type OrgPickerDeps = {
  store: OAuthStoreApi;
  /** apps/web base URL — the tRPC executor queried for the org list. */
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** A selectable organization; `id` is the value posted back to the worker. */
export type OrgOption = { id: string; name: string };

/** The personal (org-less) context: always available for a Kilo login. */
export const PERSONAL_ORG_ID = 'personal';

/** The catalog query used to list the caller's orgs (read-only, in the dump). */
export const ORG_LIST_QUERY_PATH = 'organizations.list';

const PICKER_STYLE =
  '.org{display:flex;align-items:center;gap:10px;padding:12px 14px;margin:8px 0;' +
  'border:1px solid #262a34;border-radius:10px;cursor:pointer}' +
  '.org input{accent-color:#5b5bd6}' +
  // the shared shell styles a.cta only; the submit button gets the same CTA look.
  'button.cta{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:8px;' +
  'background:#5b5bd6;color:#fff;font-weight:600;border:0;cursor:pointer}' +
  '.err{color:#f87171}';

/**
 * Fetch the Kilo identity's organizations by calling the catalog tRPC query
 * with the approved Kilo bearer. Returns the selectable options with the
 * personal context first (an approved Kilo login always has it, so the picker
 * is never empty). Throws on any upstream failure — the caller renders a
 * retryable error.
 */
export async function fetchOrgOptions(
  deps: Pick<OrgPickerDeps, 'webBaseUrl' | 'fetchImpl'>,
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

/** A paired-but-not-yet-approved code is exactly what the picker handles. */
type PickerRecord = OAuthCodeRecord & { kiloUserId: string; kiloToken: string };

function isReadyForPicker(record: OAuthCodeRecord, nowIso: string): record is PickerRecord {
  return (
    record.status === 'pending' &&
    record.expiresAt > nowIso &&
    typeof record.kiloUserId === 'string' &&
    record.kiloUserId.length > 0 &&
    typeof record.kiloToken === 'string' &&
    record.kiloToken.length > 0
  );
}

/** Rebuild the client's original /authorize request from the stored record. */
function restartAuthorizeUrl(request: Request, record: OAuthCodeRecord): string {
  const url = new URL(AUTH_PATHS.authorize, new URL(request.url).origin);
  url.searchParams.set('client_id', record.clientId);
  url.searchParams.set('redirect_uri', record.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', record.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', record.resource);
  url.searchParams.set('scope', record.scope);
  if (record.state) url.searchParams.set('state', record.state);
  return url.toString();
}

/** The picker HTML: one radio per selectable context + a Connect button. */
export function orgPickerPage(input: {
  clientName: string;
  actionUrl: string;
  options: OrgOption[];
  error: string | null;
}): Response {
  const optionsHtml = input.options
    .map(
      (option, index) =>
        `<label class="org"><input type="radio" name="organization_id" value="${escapeHtml(option.id)}"` +
        `${index === 0 ? ' checked' : ''}><span>${escapeHtml(option.name)}</span></label>`
    )
    .join('');
  const errorHtml = input.error
    ? `<p id="error" role="alert" class="err">${escapeHtml(input.error)}</p>`
    : '';
  const body =
    `<h1>Choose a Kilo organization</h1>` +
    `<p><strong>${escapeHtml(input.clientName)}</strong> is connecting to Kilo MCP. ` +
    `Pick the account to use.</p>` +
    errorHtml +
    `<form method="post" action="${escapeHtml(input.actionUrl)}">` +
    `<div class="orgs">${optionsHtml}</div>` +
    `<button class="cta" type="submit">Connect</button>` +
    `</form>`;
  const page = authPage('Choose a Kilo organization', body);
  // The picker needs radio-list layout the shared shell does not carry.
  return htmlResponse(page.replace('</head>', `<style>${PICKER_STYLE}</style></head>`));
}

function redirectWithCode(record: OAuthCodeRecord): Response {
  const redirect = new URL(record.redirectUri);
  redirect.searchParams.set('code', record.code);
  if (record.state) redirect.searchParams.set('state', record.state);
  // Plain 302 (not Response.redirect) so withAuthCors can extend the headers.
  return withAuthCors(
    new Response(null, { status: 302, headers: { Location: redirect.toString() } })
  );
}

/**
 * GET/POST /authorize/org. GET renders the picker; POST binds the chosen org
 * (validated against a fresh membership fetch) and redirects to the client.
 */
export async function handleOrgPicker(request: Request, deps: OrgPickerDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorPage('invalid_request', 'Use GET or POST for /authorize/org.');
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return errorPage('invalid_request', 'Missing authorization code.');
  }
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const record = await deps.store.getCode(code);
  if (
    !record ||
    record.expiresAt <= nowIso ||
    record.status === 'used' ||
    record.status === 'denied'
  ) {
    return errorPage(
      'invalid_request',
      'This request is no longer valid. Close this tab and retry from your MCP client.'
    );
  }
  // Already approved (double submit, or the picker reopened after success):
  // complete the client redirect instead of asking again.
  if (record.status === 'approved') {
    return redirectWithCode(record);
  }
  if (!isReadyForPicker(record, nowIso)) {
    // Kilo sign-in not finished for this record: send the user back through
    // the consent page for the SAME pairing (the device-auth code is stored).
    const client = await deps.store.getClient(record.clientId);
    return consentPage({
      clientName: client?.clientName ?? 'your MCP client',
      scope: record.scope,
      webSignInUrl: `${deps.webBaseUrl.replace(/\/$/, '')}/device-auth?code=${encodeURIComponent(record.deviceAuthCode)}`,
      statusUrl: `/authorize/status?code=${encodeURIComponent(record.code)}`,
      restartUrl: restartAuthorizeUrl(request, record),
    });
  }

  const client = await deps.store.getClient(record.clientId);
  const clientName = client?.clientName ?? 'your MCP client';
  const actionUrl = `${AUTH_PATHS.orgPicker}?code=${encodeURIComponent(record.code)}`;

  /** Render the picker offering only the personal context with a retry message. */
  const personalOnlyPage = (error: string) =>
    orgPickerPage({
      clientName,
      actionUrl,
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error,
    });

  /** Bind the chosen context and complete the authorize; stops on a lost race. */
  const approveAndRedirect = async (organizationId: string | null): Promise<Response> => {
    const approved = await deps.store.approveCode(
      record.deviceAuthCode,
      { kiloUserId: record.kiloUserId, organizationId },
      nowIso
    );
    if (!approved) {
      // Lost the race to an expiry or a concurrent denial: stop, do not redirect.
      return errorPage(
        'invalid_request',
        'This request is no longer valid. Close this tab and retry from your MCP client.'
      );
    }
    return redirectWithCode({ ...record, organizationId });
  };

  if (request.method === 'GET') {
    let options: OrgOption[];
    try {
      options = await fetchOrgOptions(deps, record.kiloToken);
    } catch {
      // Retryable unhappy: the org list is a live read, so the personal context
      // stays selectable and the same submit completes the flow on retry.
      return personalOnlyPage(
        'Could not load your organizations right now — only the personal account is offered. Choose it, or retry.'
      );
    }
    return orgPickerPage({ clientName, actionUrl, options, error: null });
  }

  // POST. The personal context is always valid for an approved Kilo login (the
  // userId already sits on the record), so it must not depend on the live
  // membership read — otherwise the retry copy above points at a dead end.
  const form = await request.formData().catch(() => null);
  const submitted = form?.get('organization_id');
  if (typeof submitted !== 'string' || submitted.length === 0) {
    const options = await fetchOrgOptions(deps, record.kiloToken).catch(() => null);
    return options
      ? orgPickerPage({ clientName, actionUrl, options, error: 'Choose an account to continue.' })
      : personalOnlyPage('Choose an account to continue.');
  }
  if (submitted === PERSONAL_ORG_ID) {
    return approveAndRedirect(null);
  }
  // Concrete orgs stay validated against the freshly-fetched membership list:
  // a client cannot authorize an org it is not a member of by editing the form.
  let options: OrgOption[];
  try {
    options = await fetchOrgOptions(deps, record.kiloToken);
  } catch {
    return personalOnlyPage(
      'Could not load your organizations right now — only the personal account is offered. Choose it, or retry.'
    );
  }
  const chosen = options.find(option => option.id === submitted);
  if (!chosen) {
    return orgPickerPage({
      clientName,
      actionUrl,
      options,
      error: 'That organization is not available for this account.',
    });
  }
  return approveAndRedirect(chosen.id === PERSONAL_ORG_ID ? null : chosen.id);
}
