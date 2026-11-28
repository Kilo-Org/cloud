import { z } from 'zod';
import { UtsAudienceSchema, UtsScopeSchema } from './token';

/**
 * The bot-token mint (design 5.3, 6.5): a workload that runs as an internal bot account, such as
 * the bouncer watch or the auto-routing benchmark, gets one short-lived UTS access token for that
 * account. It replaces the web app's `/api/internal/bot-token` and its shared mint secret.
 *
 * Request: `POST <issuer>/internal/bot-tokens` with `Authorization: Bearer <STS token>` for
 * audience `uts` and the one STS scope `uts:bot-token.mint`, and a JSON body that names the bot
 * account, one audience and one scope of that audience. The mint Worker's `BOT_TOKEN_POLICIES`
 * says which bot accounts each calling workload may mint for, in which organization, which scopes
 * and how long; a workload without a policy is refused.
 *
 * The token is an ordinary UTS access token of the bot account: `sub` is the account, `client_id`
 * and `req` name the calling workload, `org` is the policy's organization, and `bot_user` is
 * `true`. It carries no `sid`, `auth_time`, `amr` or `act`, and no refresh token is issued: the
 * workload mints again. Blocking the bot account stops new tokens at once and puts the account on
 * the revocation feed, so verifiers refuse the tokens already issued.
 */

/** The `/internal/` route of the mint. */
export const UTS_BOT_TOKEN_PATH = '/internal/bot-tokens';

/** The STS scope (audience `uts`) a caller's service token must carry. */
export const UTS_BOT_TOKEN_MINT_SCOPE = 'uts:bot-token.mint';

/** Design 5.3: a bot token lives at most 1 hour; each policy sets its own lifetime up to it. */
export const UTS_BOT_TOKEN_MAX_LIFETIME_SECONDS = 3600;

/**
 * An internal bot account id as the web app makes it: `bot-internal-` and a slug of 1 to 41
 * lower-case letters, digits and hyphens that starts with a letter or digit.
 */
export const UtsBotAccountSchema = z.string().regex(/^bot-internal-[a-z0-9][a-z0-9-]{0,40}$/);

export const BotTokenRequestSchema = z.strictObject({
  account: UtsBotAccountSchema,
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
});
export type BotTokenRequest = z.infer<typeof BotTokenRequestSchema>;

/** The success answer. `expires_in` is the token's whole lifetime in seconds. */
export const BotTokenResponseSchema = z.strictObject({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(UTS_BOT_TOKEN_MAX_LIFETIME_SECONDS),
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
});
export type BotTokenResponse = z.infer<typeof BotTokenResponseSchema>;

/**
 * The refusals with a JSON body `{ error, error_description? }`:
 *
 * * 400 `invalid_request`: the body is not a `BotTokenRequest`.
 * * 400 `invalid_target`: `audience` is not the audience of `scope`.
 * * 400 `invalid_scope`: the caller's policy for the account does not grant the scope.
 * * 401 `invalid_token`: no STS token, or not a valid one for audience `uts`.
 * * 403 `insufficient_scope`: a valid STS token for another scope (with `WWW-Authenticate`), or a
 *   workload that has no policy (without it).
 * * 403 `access_denied`: no policy of the caller names the account (`unknown_account`), the
 *   account is missing or blocked (`account_inactive`), or it is not an active owner or member
 *   of the policy's organization in a role the scope allows (`membership_denied`); the reason is
 *   the `error_description`.
 * * 404 `not_found`: the environment configures no policy, so the mint is off.
 * * 503 `temporarily_unavailable` with `Retry-After`: the STS key set, the identity store or the
 *   signer did not answer; the only refusal worth a retry.
 * * 500 `server_error`.
 */
export const BOT_TOKEN_DENIALS = [
  'unknown_account',
  'account_inactive',
  'membership_denied',
] as const;
export type BotTokenDenial = (typeof BOT_TOKEN_DENIALS)[number];
