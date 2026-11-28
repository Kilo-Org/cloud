import {
  type HomeWidgetGrantResponse,
  KILO_API_HOME_WIDGET_SCOPE,
  KILO_MOBILE_CLIENT_ID,
  UTS_ACCESS_TOKEN_TYPE_URN,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env } from '../env';
import { requestClient } from '../oauth/clients';
import { failureResponse, oauthError } from '../oauth/errors';
import type { Params } from '../oauth/params';
import { firstPartyProof, replayedDpopProof } from '../oauth/proof';
import {
  type TokenDeps,
  grantError,
  required,
  signMinted,
  tokenEndpointUrl,
  tokenSelection,
} from '../oauth/token-endpoint';
import { jsonResponse } from '../responses';
import type { MintClient } from '../scopes/policy';
import {
  firstPartyRefreshToken,
  grantIdOfFirstPartyRefreshToken,
  randomCredential,
  sha256,
} from '../token/credentials';

/**
 * The home-widget exchange at `POST /token` (design 5.5, 9.3; wire contract in
 * `@kilocode/uts-contracts`, `home-widget.ts`): RFC 8693 with the mobile app's own refresh token
 * as the subject (`subject_token_type` refresh token). It reuses the first-party grant model
 * rather than adding a grant type: the result is an ordinary DPoP-bound refresh grant of the same
 * device session and key, narrowed to `kilo-api:home-widget.use`, which the widget refreshes with
 * the `refresh_token` grant like any first-party client.
 *
 * Steps, each refusing before the next costs anything:
 * 1. the client: `kilo-mobile` only (`unauthorized_client`);
 * 2. the form: the subject token, `requested_token_type` absent or an access token, no actor or
 *    `audience`, exactly the scope `kilo-api:home-widget.use` (`invalid_scope`), an optional
 *    `kilo-api` resource (`invalid_target`) and an optional organization id;
 * 3. the DPoP proof of the request (`invalid_dpop_proof`);
 * 4. one SQL statement (`uts.exchange_home_widget_grant`, migration 0024): the app grant and its
 *    key, the proof's `jti`, the scope, the hourly limit, the organization, the replaced widget
 *    grant and the audit rows;
 * 5. one feed publish when a previous widget grant was replaced, and one signer call.
 *
 * A failure after the statement committed (feed objects or signer) leaves the widget grant stored
 * without its refresh token reaching the client; the client exchanges again, and that exchange
 * replaces the stored grant. A failed publish does not fail the exchange: the backfill adds the
 * replaced grant's entry within seconds (design 5.6).
 */

export type HomeWidgetDeps = Pick<TokenDeps, 'config' | 'grants' | 'sign' | 'scopes' | 'publish'>;

/**
 * Whether the exchange is offered: `on` only where `HOME_WIDGET_GRANT_ENABLED` is exactly `true`.
 * Off everywhere else, including on a malformed value, which is logged by name.
 */
export type HomeWidgetService = { status: 'on' } | { status: 'off' };

const SwitchSchema = z.literal('true').optional();

export function homeWidgetService(env: Pick<Env, 'HOME_WIDGET_GRANT_ENABLED'>): HomeWidgetService {
  const parsed = SwitchSchema.safeParse(env.HOME_WIDGET_GRANT_ENABLED);
  if (!parsed.success) {
    console.error(
      JSON.stringify({ event: 'uts.home_widget.misconfigured', var: 'HOME_WIDGET_GRANT_ENABLED' })
    );
    return { status: 'off' };
  }
  return parsed.data === 'true' ? { status: 'on' } : { status: 'off' };
}

const FORBIDDEN_PARAMS = ['actor_token', 'actor_token_type', 'audience'] as const;
const OrgIdSchema = z.uuid();

export async function handleHomeWidgetExchange(
  request: Request,
  params: Params,
  deps: HomeWidgetDeps
): Promise<Response> {
  // 1. The client.
  const identity = requestClient(params);
  if (identity instanceof Response) return identity;
  if (identity.kind !== 'first_party' || identity.client.clientId !== KILO_MOBILE_CLIENT_ID) {
    return oauthError(
      'unauthorized_client',
      400,
      'only the mobile app exchanges its grant for a widget grant'
    );
  }
  const client: MintClient = { kind: 'first_party', clientId: identity.client.clientId };

  // 2. The form.
  const subjectToken = required(params, 'subject_token');
  if (subjectToken instanceof Response) return subjectToken;
  const requestedType = params.one('requested_token_type');
  if (
    requestedType.status === 'repeated' ||
    (requestedType.status === 'present' && requestedType.value !== UTS_ACCESS_TOKEN_TYPE_URN) ||
    FORBIDDEN_PARAMS.some(name => params.one(name).status !== 'absent')
  ) {
    return oauthError(
      'invalid_request',
      400,
      'requested_token_type must be an access token; actor_token and audience are not taken'
    );
  }
  const selection = tokenSelection(params, deps, client);
  if (selection instanceof Response) return selection;
  if (selection.scopes?.length !== 1 || selection.scopes[0] !== KILO_API_HOME_WIDGET_SCOPE) {
    return oauthError('invalid_scope', 400, `scope must be ${KILO_API_HOME_WIDGET_SCOPE}`);
  }
  const orgParam = params.one('org');
  const org = orgParam.status === 'present' ? OrgIdSchema.safeParse(orgParam.value) : null;
  if (orgParam.status === 'repeated' || (org !== null && !org.success)) {
    return oauthError('invalid_request', 400, 'org must be one organization id');
  }
  const parentGrantId = grantIdOfFirstPartyRefreshToken(subjectToken);
  if (parentGrantId === null) return grantError('invalid_grant');

  // 3. The DPoP proof of the app grant's key.
  const proof = await firstPartyProof(request, tokenEndpointUrl(deps.config));
  if (proof instanceof Response) return proof;

  // 4. The statement.
  const widgetGrantId = crypto.randomUUID();
  const widgetToken = firstPartyRefreshToken(widgetGrantId, randomCredential());
  let result;
  try {
    result = await deps.grants(async grants =>
      grants.exchangeHomeWidget({
        environment: deps.config.environment,
        parentTokenHash: await sha256(subjectToken),
        parentGrantId,
        clientId: client.clientId,
        proof,
        widgetGrantId,
        widgetTokenHash: await sha256(widgetToken),
        scope: KILO_API_HOME_WIDGET_SCOPE,
        orgId: org?.data ?? null,
      })
    );
  } catch (error) {
    return failureResponse(error, 'home_widget_exchange');
  }
  switch (result.outcome) {
    case 'issued':
      break;
    case 'dpop_replay':
      return replayedDpopProof();
    case 'invalid_scope':
      return oauthError(
        'invalid_scope',
        400,
        `the grant does not list ${KILO_API_HOME_WIDGET_SCOPE}`
      );
    case 'org_denied':
      return oauthError('invalid_grant', 400, 'the grant cannot act in that organization');
    case 'rate_limited':
      return oauthError(
        'slow_down',
        429,
        'too many widget grants for this grant in the last hour',
        {
          'Retry-After': String(result.retryAfterSeconds),
        }
      );
    case 'invalid_grant':
    case 'dpop_mismatch':
      return grantError(result.outcome);
  }

  // 5. The replaced widget grant's feed entry, then the signer call.
  await deps.publish(result.feedEntries);
  const signed = await signMinted(deps, client, widgetGrantId, result);
  if (signed instanceof Response) return signed;
  const [claims] = signed.claims;
  const [accessToken] = signed.tokens;
  const expiresIn = claims.exp - claims.iat;
  const body: HomeWidgetGrantResponse = {
    access_token: accessToken,
    issued_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: KILO_API_HOME_WIDGET_SCOPE,
    issued_tokens: [
      {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        audience: claims.aud,
        scope: claims.scope,
      },
    ],
    refresh_token: widgetToken,
    refresh_token_expires_in: Math.max(
      1,
      Math.floor((result.refreshExpiresAt.getTime() - signed.nowMs) / 1000)
    ),
  };
  return jsonResponse(body, 200, { Pragma: 'no-cache' });
}
