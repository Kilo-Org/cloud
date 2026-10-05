import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * One HS256 bearer-grant codec shared by every control-plane object-storage
 * grant (control-log upload, worktree-state). The security-relevant rules —
 * algorithm pinning, audience and type binding, bearer shape, header cap, and
 * the `iat`/`exp` bounds — live here once so the grant families cannot drift.
 */
export type Hs256GrantCodec<TIdentity> = {
  mint(identity: TIdentity, secret: string): string;
  validate(authorization: string | null, secret: string | null): TIdentity | undefined;
};

export function createHs256GrantCodec<TIdentity>(options: {
  type: string;
  audience: string;
  lifetimeSeconds: number;
  identitySchema: z.ZodType<TIdentity>;
}): Hs256GrantCodec<TIdentity> {
  const grantSchema = z
    .object({
      type: z.literal(options.type),
      aud: z.literal(options.audience),
      identity: options.identitySchema,
      iat: z.number().int().nonnegative(),
      exp: z.number().int().nonnegative(),
    })
    .strict();

  return {
    mint(identity, secret) {
      return jwt.sign(
        { type: options.type, identity: options.identitySchema.parse(identity) },
        secret,
        { algorithm: 'HS256', audience: options.audience, expiresIn: options.lifetimeSeconds }
      );
    },
    validate(authorization, secret) {
      if (!secret || !authorization || authorization.length > 4096) return undefined;
      const match = /^Bearer (\S+)$/.exec(authorization);
      if (!match) return undefined;
      try {
        const parsed = grantSchema.safeParse(
          jwt.verify(match[1], secret, { algorithms: ['HS256'], audience: options.audience })
        );
        if (!parsed.success) return undefined;
        const { iat, exp, identity } = parsed.data;
        if (exp <= iat || exp - iat > options.lifetimeSeconds || iat > Date.now() / 1000 + 30) {
          return undefined;
        }
        return identity;
      } catch {
        return undefined;
      }
    },
  };
}
