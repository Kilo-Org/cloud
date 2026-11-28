import { z } from 'zod';
import { UtsEnvironmentSchema } from './environment';

/** Design 5.3: a UTS access token lives 10 minutes. */
export const UTS_ACCESS_TOKEN_LIFETIME_SECONDS = 600;

/** Design 5.3: one token call mints up to 8 access tokens, each with one audience and one scope. */
export const UTS_MAX_TOKENS_PER_CALL = 8;

/** The JWS `typ` of every UTS access token (RFC 9068, section 2.1). */
export const UTS_ACCESS_TOKEN_TYPE = 'at+jwt';

/** Prefix of a first-party refresh grant (design 5.3), fixed so secret scanners can find one. */
export const UTS_REFRESH_TOKEN_PREFIX = 'kilo_rt_';

/** A service that accepts tokens, such as `gateway`: the one value of a token's `aud`. */
export const UtsAudienceSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

/** One permission on one service, `<audience>:<permission>`, such as `gateway:models.read`. */
export const UtsScopeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9_.-]{0,62}$/);

/** The audience a scope belongs to: the part before the first colon. */
export function audienceOfScope(scope: string): string {
  return scope.slice(0, scope.indexOf(':'));
}

/** RFC 8693 `act`: one entry per delegation hop, the outermost entry is the current actor. */
type Actor = { sub: string; client_id?: string; act?: Actor };
const ActorSchema: z.ZodType<Actor> = z.strictObject({
  sub: z.string().min(1),
  client_id: z.string().min(1).optional(),
  get act() {
    return ActorSchema.optional();
  },
});

const NumericDateSchema = z.number().int().positive();

/**
 * The claims of a UTS access token, exactly (design 5.3, RFC 9068): `iss exp aud sub client_id iat
 * jti scope org act req sid auth_time amr env bot_user`, one audience and one scope of that
 * audience. `org` names the one bound organization; `act` appears only on a delegated token (RFC
 * 8693) and `req` on a delegated token or a bot token; `sid`, `auth_time` and `amr` appear on
 * every token minted from a grant; `bot_user` is `true` on a bot token (`bot-token.ts`) and
 * absent on every other token.
 *
 * Phase 2 owns the published claim contract (`AccessTokenClaimsSchema` in
 * `@kilocode/sts-contracts`). Until that package carries it on this branch, UTS declares its own
 * profile here; every claim set this schema accepts also passes the signer's admission check.
 */
export const UtsAccessTokenClaimsSchema = z
  .strictObject({
    iss: z.url(),
    exp: NumericDateSchema,
    aud: UtsAudienceSchema,
    sub: z.string().min(1).max(255),
    client_id: z.string().min(1).max(2048),
    iat: NumericDateSchema,
    jti: z.uuid(),
    scope: UtsScopeSchema,
    org: z.uuid().optional(),
    act: ActorSchema.optional(),
    req: z.string().min(1).optional(),
    sid: z.uuid().optional(),
    auth_time: NumericDateSchema.optional(),
    amr: z.array(z.string().min(1)).min(1).max(8).optional(),
    env: UtsEnvironmentSchema,
    bot_user: z.literal(true).optional(),
  })
  .refine(
    claims => audienceOfScope(claims.scope) === claims.aud,
    'scope must belong to the audience'
  )
  .refine(claims => claims.exp > claims.iat, 'exp must be after iat');
export type UtsAccessTokenClaims = z.infer<typeof UtsAccessTokenClaimsSchema>;
