import { z } from 'zod';
import { UTS_ACCESS_TOKEN_TYPE_URN } from './exchange';
import { IssuedTokenSchema } from './oauth';
import { KILO_API_HOME_WIDGET_SCOPE } from './scopes';
import { UTS_ACCESS_TOKEN_LIFETIME_SECONDS, UTS_REFRESH_TOKEN_PREFIX } from './token';

/**
 * The home-widget exchange at the UTS token endpoint (design 5.5, 9.3). The mobile app
 * (`kilo-mobile`) exchanges its own refresh grant for a widget grant: a refresh grant of the same
 * device session and DPoP key that holds only `kilo-api:home-widget.use`. The widget extension
 * keeps that grant and refreshes 10-minute access tokens with the ordinary `refresh_token` grant;
 * it never holds the app's grant.
 *
 * Request: `POST /token`, form-encoded, with a DPoP proof of the app grant's key (RFC 9449):
 * - `grant_type`: `urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693);
 * - `client_id`: `kilo-mobile`;
 * - `subject_token`: the app's `kilo_rt_` refresh token;
 * - `subject_token_type`: `UTS_REFRESH_TOKEN_TYPE_URN`;
 * - `scope`: `kilo-api:home-widget.use`, which the app's grant must list;
 * - optional `requested_token_type`: `UTS_ACCESS_TOKEN_TYPE_URN`, the only type issued;
 * - optional `resource`: the `kilo-api` resource indicator (RFC 8707);
 * - optional `org`: the organization the widget shows. An app grant bound to an organization
 *   names that one or none; a personal app grant may name any organization in which the account
 *   is an active member and meets the SSO requirement (design 5.8).
 *
 * The answer is `HomeWidgetGrantResponseSchema`. A new exchange revokes the app grant's previous
 * widget grant, so one app grant holds at most one widget grant. Revoking the widget grant
 * (`/revoke` with its refresh token) ends only the widget; revoking the app's grant or its device
 * session ends both.
 */

/** RFC 8693 section 3: the token type of a refresh token, here the subject's. */
export const UTS_REFRESH_TOKEN_TYPE_URN = 'urn:ietf:params:oauth:token-type:refresh_token';

/**
 * Widget grants one app grant may create in any hour. Past it the exchange answers 429
 * `slow_down` with `Retry-After`: each exchange revokes the previous widget grant, and each
 * revoked grant holds a revocation-feed entry for 20 minutes.
 */
export const UTS_HOME_WIDGET_GRANTS_PER_HOUR = 10;

/**
 * The success answer: an RFC 6749 token response for the widget's first access token, with the
 * RFC 8693 `issued_token_type`, and the widget grant's refresh token. `refresh_token_expires_in`
 * never passes the app grant's idle expiry at the time of the exchange, so the widget grant never
 * outlives the app grant; the app exchanges again before then.
 */
export const HomeWidgetGrantResponseSchema = z
  .strictObject({
    access_token: z.string().min(1),
    issued_token_type: z.literal(UTS_ACCESS_TOKEN_TYPE_URN),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().max(UTS_ACCESS_TOKEN_LIFETIME_SECONDS),
    scope: z.literal(KILO_API_HOME_WIDGET_SCOPE),
    issued_tokens: z.tuple([IssuedTokenSchema]),
    refresh_token: z.string().startsWith(UTS_REFRESH_TOKEN_PREFIX),
    refresh_token_expires_in: z.number().int().positive(),
  })
  .refine(
    response =>
      response.issued_tokens[0].access_token === response.access_token &&
      response.issued_tokens[0].scope === response.scope,
    'the standard members describe the one issued token'
  );
export type HomeWidgetGrantResponse = z.infer<typeof HomeWidgetGrantResponseSchema>;
