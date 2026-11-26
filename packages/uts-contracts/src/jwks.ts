import { z } from 'zod';

/** Design 5.7: UTS signs in 16 signer objects, each with its own keys. */
export const UTS_SIGNER_COUNT = 16;

/** A base64url value of 32 bytes without padding: an Ed25519 public key or a SHA-256 digest. */
const Base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const UtsSignerIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(UTS_SIGNER_COUNT - 1);

const TOKEN_KID_PREFIX = 'uts-token-';
const TOKEN_KID_PATTERN = /^uts-token-(\d{2})-[A-Za-z0-9_-]{43}$/;

/**
 * The `kid` of a token signing key: `uts-token-<signer, two digits>-<RFC 7638 thumbprint>`. The
 * prefix names the key's role. The feed keys that later join the same key set carry their own
 * prefix, so a verifier selects token keys by this schema and never accepts a feed key for a token.
 */
export const UtsTokenKidSchema = z
  .string()
  .regex(TOKEN_KID_PATTERN)
  .refine(kid => signerOfTokenKid(kid) !== null, 'signer index out of range');

export function tokenKid(signer: number, thumbprint: string): string {
  const index = UtsSignerIndexSchema.parse(signer);
  return `${TOKEN_KID_PREFIX}${String(index).padStart(2, '0')}-${Base64Url32Schema.parse(thumbprint)}`;
}

/** The signer index a token `kid` names, or null when the value is not a token `kid`. */
export function signerOfTokenKid(kid: string): number | null {
  const match = TOKEN_KID_PATTERN.exec(kid);
  if (match === null) return null;
  const index = UtsSignerIndexSchema.safeParse(Number(match[1]));
  return index.success ? index.data : null;
}

/** One public key of the UTS key set (RFC 8037 OKP key, RFC 7517 members). */
export const UtsPublicJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: Base64Url32Schema,
  kid: z.string().min(1),
  alg: z.literal('EdDSA'),
  use: z.literal('sig'),
});
export type UtsPublicJwk = z.infer<typeof UtsPublicJwkSchema>;

function uniqueKids(keys: readonly UtsPublicJwk[]): boolean {
  return new Set(keys.map(key => key.kid)).size === keys.length;
}

/**
 * The UTS key set the feed Worker serves at `jwks_uri`: the current and next key of every signer
 * object, plus each retired key until 10 minutes after the last token it signed expires.
 */
export const UtsJwksSchema = z.strictObject({
  keys: z.array(UtsPublicJwkSchema).min(1).refine(uniqueKids, 'duplicate kid'),
});
export type UtsJwks = z.infer<typeof UtsJwksSchema>;
