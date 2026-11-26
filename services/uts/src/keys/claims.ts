import { UtsEnvironmentSchema } from '@kilocode/uts-contracts';
import { z } from 'zod';

/**
 * What a UTS signer accepts before it signs. The published access-token claim contract is phase 2's
 * `AccessTokenClaimsSchema` (`@kilocode/sts-contracts`, design 5.3 and 7), which this branch does
 * not carry; this check is the signer's own admission rule and is stricter than that contract on
 * purpose: one audience, one scope of that audience, no claim outside RFC 9068 and design 5.3, and
 * a lifetime no longer than the longest UTS token. Every claim set it accepts passes the contract.
 */

/** Design 5.7 header: `alg: EdDSA`, `typ: at+jwt`, and the signing key's `kid`. */
export const UTS_TOKEN_ALG = 'EdDSA';
export const UTS_TOKEN_TYPE = 'at+jwt';

/**
 * The longest lifetime any UTS-signed token has: the CI token and the sandbox fallback token live
 * 1 hour (design 5.3). A retired key stays published until this plus 10 minutes after it stopped
 * signing, so the signer refuses any claim set that would outlive it.
 */
export const UTS_MAX_TOKEN_LIFETIME_SECONDS = 60 * 60;

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

/** A service that accepts tokens, as phase 2 spells it: one audience per token, never a list. */
const AudienceSchema = z.string().regex(/^[a-z0-9-]+$/);

/** One permission on one service: `<audience>:<permission>`, such as `gateway:models.read`. */
const ScopeSchema = z.string().regex(/^[a-z0-9-]+:[a-z0-9_.-]+$/);

export const SignableClaimsSchema = z
  .strictObject({
    iss: z.url(),
    exp: NumericDateSchema,
    aud: AudienceSchema,
    sub: z.string().min(1),
    client_id: z.string().min(1),
    iat: NumericDateSchema,
    jti: z.string().min(1),
    scope: ScopeSchema,
    nbf: NumericDateSchema.optional(),
    org: z.string().min(1).optional(),
    act: ActorSchema.optional(),
    req: z.string().min(1).optional(),
    sid: z.string().min(1).optional(),
    auth_time: NumericDateSchema.optional(),
    amr: z.array(z.string().min(1)).min(1).optional(),
    env: UtsEnvironmentSchema,
  })
  .refine(claims => claims.scope.startsWith(`${claims.aud}:`), 'scope must belong to the audience')
  .refine(claims => claims.exp > claims.iat, 'exp must be after iat')
  .refine(
    claims => claims.exp - claims.iat <= UTS_MAX_TOKEN_LIFETIME_SECONDS,
    'lifetime over the UTS maximum'
  );
export type SignableClaims = z.infer<typeof SignableClaimsSchema>;
