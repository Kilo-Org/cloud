import {
  type SecurityView,
  UTS_SECURITY_LIST_LIMIT,
  UTS_SECURITY_PATH,
  UtsNoticeKindSchema,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import {
  type IdentityStore,
  IdentityStoreError,
  type WaitUntil,
  withIdentityStore,
} from '../db/client';
import { jsonResponse } from '../responses';
import { renderNotice } from './kinds';

/**
 * `GET /account/security`: the user security view (design 5.13 and 8.4). One SQL statement on the
 * read replica (login `uts_reader`, views in `uts_read` without client addresses or key material)
 * checks the caller's grant and its session and, only when both are live, reads the newest 50
 * sign-ins, the live sessions, the credentials and the newest 50 notices with their channel
 * attempts. A grant revoked on the primary fails here once the replica has applied the revoke.
 */

/** The caller as the account API's bearer check names it: the token's subject and its grant. */
export type SecurityCaller = { accountId: string; grantId: string };

export type CallerCheck =
  | { status: 'ok'; caller: SecurityCaller }
  | { status: 'refused'; response: Response };

/**
 * Checks the request's UTS access token for the `uts` audience with `uts:security.read` and a
 * `sid` (the account API's bearer check), or answers its refusal.
 */
export type SecurityAuthenticator = (request: Request) => Promise<CallerCheck>;

export type SecurityViewResult =
  | { outcome: 'listed'; view: SecurityView }
  | { outcome: 'invalid_session' };

/** Runs the view statement for one caller over one replica connection. */
export type SecurityViewRead = (caller: SecurityCaller) => Promise<SecurityViewResult>;

export type SecurityViewDeps = { authenticate: SecurityAuthenticator; read: SecurityViewRead };

/** Grant check first; the lists run only for a live session (a CASE branch is evaluated lazily). */
export const SECURITY_VIEW_STATEMENT = `
WITH caller AS (
  SELECT EXISTS (
    SELECT 1
    FROM uts_read.refresh_grants AS grant_row
    JOIN uts_read.device_sessions AS session ON session.id = grant_row.device_session_id
    JOIN uts_read.accounts AS account ON account.id = grant_row.account_id
    WHERE grant_row.id = $2 AND grant_row.account_id = $1
      AND grant_row.status = 'active'
      AND grant_row.expires_at > now() AND grant_row.idle_expires_at > now()
      AND session.status = 'active' AND account.status = 'active'
  ) AS live
)
SELECT caller.live, CASE WHEN caller.live THEN json_build_object(
  'sign_ins', (
    SELECT coalesce(json_agg(json_build_object(
      'id', sign_in.id,
      'signed_in_at', sign_in.signed_in_at,
      'session_kind', sign_in.session_kind,
      'device_label', sign_in.device_label,
      'platform', sign_in.platform,
      'methods', to_json(sign_in.amr::text[]),
      'network', json_build_object('asn', sign_in.asn, 'country', sign_in.country, 'city', sign_in.city),
      'new_device', sign_in.new_device,
      'new_network', sign_in.new_network
    ) ORDER BY sign_in.signed_in_at DESC), '[]')
    FROM (
      SELECT * FROM uts_read.sign_ins WHERE account_id = $1
      ORDER BY signed_in_at DESC LIMIT $3
    ) AS sign_in
  ),
  'sessions', (
    SELECT coalesce(json_agg(live_session.item ORDER BY live_session.last_seen_at DESC), '[]')
    FROM (
      SELECT browser.last_seen_at, json_build_object(
        'id', browser.id, 'kind', 'browser', 'client_class', NULL,
        'device_label', left(browser.user_agent, 128), 'platform', NULL,
        'signed_in_at', browser.auth_time, 'last_seen_at', browser.last_seen_at,
        'methods', to_json(browser.amr::text[]),
        'network', json_build_object('asn', browser.asn, 'country', browser.country, 'city', browser.city)
      ) AS item
      FROM uts_read.browser_sessions AS browser
      WHERE browser.account_id = $1 AND browser.status = 'active'
        AND browser.expires_at > now() AND browser.idle_expires_at > now()
      UNION ALL
      SELECT device.last_seen_at, json_build_object(
        'id', device.id, 'kind', 'device', 'client_class', device.client_class,
        'device_label', device.device_label, 'platform', device.platform,
        'signed_in_at', device.auth_time, 'last_seen_at', device.last_seen_at,
        'methods', to_json(device.amr::text[]),
        'network', json_build_object('asn', device.asn, 'country', device.country, 'city', device.city)
      )
      FROM uts_read.device_sessions AS device
      WHERE device.account_id = $1 AND device.status = 'active'
    ) AS live_session
  ),
  'passkeys', (
    SELECT coalesce(json_agg(json_build_object(
      'id', passkey.id, 'name', passkey.name, 'backed_up', passkey.backed_up,
      'added_at', passkey.added_at, 'last_used_at', passkey.last_used_at
    ) ORDER BY passkey.added_at DESC), '[]')
    FROM uts_read.passkeys AS passkey WHERE passkey.account_id = $1
  ),
  'sign_in_methods', (
    SELECT coalesce(json_agg(json_build_object(
      'id', method.id, 'provider', method.provider,
      'added_at', method.added_at, 'last_used_at', method.last_used_at
    ) ORDER BY method.added_at DESC), '[]')
    FROM uts_read.sign_in_methods AS method WHERE method.account_id = $1
  ),
  'pats', (
    SELECT coalesce(json_agg(json_build_object(
      'id', pat.id, 'name', pat.name, 'audience', pat.audience, 'scope', pat.scope,
      'last_four', pat.last_four, 'created_at', pat.created_at, 'expires_at', pat.expires_at,
      'last_used_at', pat.last_used_at
    ) ORDER BY pat.created_at DESC), '[]')
    FROM uts_read.personal_access_tokens AS pat
    WHERE pat.account_id = $1 AND pat.status = 'active' AND pat.expires_at > now()
  ),
  'third_party_clients', (
    SELECT coalesce(json_agg(json_build_object(
      'id', consent.id, 'client_id', consent.client_id, 'client_name', consent.client_name,
      'scopes', to_json(consent.scopes::text[]), 'granted_at', consent.granted_at
    ) ORDER BY consent.granted_at DESC), '[]')
    FROM uts_read.third_party_consents AS consent
    WHERE consent.account_id = $1 AND consent.status = 'active'
  ),
  'ci_trust_policies', (
    SELECT coalesce(json_agg(json_build_object(
      'id', policy.id, 'repository', policy.repository, 'audience', policy.audience,
      'scopes', to_json(policy.scopes::text[]), 'created_at', policy.created_at
    ) ORDER BY policy.created_at DESC), '[]')
    FROM uts_read.ci_trust_policies AS policy
    WHERE policy.account_id = $1 AND policy.status = 'active'
  ),
  'notices', (
    SELECT coalesce(json_agg(json_build_object(
      'id', notice.id, 'kind', notice.kind, 'details', notice.details,
      'created_at', notice.created_at, 'delivery', notice.delivery,
      'attempts', (
        SELECT coalesce(json_agg(json_build_object(
          'round', attempt.round, 'channel', attempt.channel, 'outcome', attempt.outcome,
          'attempted_at', attempt.attempted_at
        ) ORDER BY attempt.round, attempt.position), '[]')
        FROM uts_read.notice_attempts AS attempt WHERE attempt.notice_id = notice.id
      )
    ) ORDER BY notice.created_at DESC), '[]')
    FROM (
      SELECT * FROM uts_read.notices WHERE account_id = $1
      ORDER BY created_at DESC LIMIT $3
    ) AS notice
  )
) END AS view
FROM caller`;

/** A JSON timestamp of the session's time zone, as an ISO string in UTC. */
const Time = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const Network = z.strictObject({
  asn: z.number().int().positive().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
});

const ViewJsonSchema = z.strictObject({
  sign_ins: z.array(
    z.strictObject({
      id: z.uuid(),
      signed_in_at: Time,
      session_kind: z.enum(['browser', 'device']),
      device_label: z.string().nullable(),
      platform: z.string().nullable(),
      methods: z.array(z.string()),
      network: Network,
      new_device: z.boolean(),
      new_network: z.boolean(),
    })
  ),
  sessions: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: z.enum(['browser', 'device']),
      client_class: z.enum(['desktop', 'mobile']).nullable(),
      device_label: z.string().nullable(),
      platform: z.string().nullable(),
      signed_in_at: Time,
      last_seen_at: Time,
      methods: z.array(z.string()),
      network: Network,
    })
  ),
  passkeys: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      backed_up: z.boolean(),
      added_at: Time,
      last_used_at: Time.nullable(),
    })
  ),
  sign_in_methods: z.array(
    z.strictObject({
      id: z.uuid(),
      provider: z.string(),
      added_at: Time,
      last_used_at: Time.nullable(),
    })
  ),
  pats: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      audience: z.string(),
      scope: z.string(),
      last_four: z.string(),
      created_at: Time,
      expires_at: Time,
      last_used_at: Time.nullable(),
    })
  ),
  third_party_clients: z.array(
    z.strictObject({
      id: z.uuid(),
      client_id: z.string(),
      client_name: z.string(),
      scopes: z.array(z.string()),
      granted_at: Time,
    })
  ),
  ci_trust_policies: z.array(
    z.strictObject({
      id: z.uuid(),
      repository: z.string(),
      audience: z.string(),
      scopes: z.array(z.string()),
      created_at: Time,
    })
  ),
  notices: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: UtsNoticeKindSchema,
      details: z.record(z.string(), z.unknown()),
      created_at: Time,
      delivery: z.enum(['pending', 'sending', 'delivered', 'failed']),
      attempts: z.array(
        z.strictObject({
          round: z.number().int().min(1).max(3),
          channel: z.enum(['push', 'email']),
          outcome: z.enum([
            'sent',
            'no_target',
            'not_configured',
            'retryable_failure',
            'permanent_failure',
          ]),
          attempted_at: Time,
        })
      ),
    })
  ),
});

const ViewRowSchema = z.discriminatedUnion('live', [
  z.object({ live: z.literal(true), view: ViewJsonSchema }),
  z.object({ live: z.literal(false), view: z.null() }),
]);

/** The view of one caller, built from the statement's JSON. */
export async function readSecurityView(
  store: IdentityStore,
  caller: SecurityCaller
): Promise<SecurityViewResult> {
  const row = await store.maybeOne(
    {
      text: SECURITY_VIEW_STATEMENT,
      values: [caller.accountId, caller.grantId, UTS_SECURITY_LIST_LIMIT],
    },
    ViewRowSchema
  );
  if (row === null) throw new Error('the security view statement returned no row');
  if (!row.live) return { outcome: 'invalid_session' };
  const { view } = row;
  return {
    outcome: 'listed',
    view: {
      sign_ins: view.sign_ins,
      sessions: view.sessions,
      credentials: {
        passkeys: view.passkeys,
        sign_in_methods: view.sign_in_methods,
        pats: view.pats,
        third_party_clients: view.third_party_clients,
        ci_trust_policies: view.ci_trust_policies,
      },
      notices: view.notices.map(notice => {
        const rendered = renderNotice(notice.kind, notice.details, new Date(notice.created_at));
        return {
          id: notice.id,
          kind: notice.kind,
          created_at: notice.created_at,
          title: rendered.title,
          text: rendered.text,
          delivery: notice.delivery,
          attempts: notice.attempts,
        };
      }),
    },
  };
}

/** Each call opens one replica connection for its statement and closes it in the background. */
export function replicaSecurityView(
  connectionString: string,
  context: WaitUntil
): SecurityViewRead {
  return caller =>
    withIdentityStore(connectionString, context, store => readSecurityView(store, caller));
}

/** The response for `GET /account/security`, or null when `pathname` is another route. */
export async function handleSecurityRequest(
  request: Request,
  pathname: string,
  deps: SecurityViewDeps
): Promise<Response | null> {
  if (pathname !== UTS_SECURITY_PATH) return null;
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  }
  const check = await deps.authenticate(request);
  if (check.status === 'refused') return check.response;
  let result: SecurityViewResult;
  try {
    result = await deps.read(check.caller);
  } catch (error) {
    if (!(error instanceof IdentityStoreError)) throw error;
    console.error(
      JSON.stringify({
        event: 'uts.security_view.failed',
        failure: error.failure,
        sqlState: error.sqlState,
      })
    );
    return error.failure === 'retryable'
      ? jsonResponse({ error: 'temporarily_unavailable' }, 503, { 'Retry-After': '5' })
      : jsonResponse({ error: 'server_error' }, 500);
  }
  if (result.outcome === 'invalid_session') {
    return jsonResponse(
      { error: 'invalid_token', error_description: 'the session of this token has ended' },
      401,
      { 'WWW-Authenticate': 'Bearer error="invalid_token"' }
    );
  }
  return jsonResponse(result.view, 200);
}
