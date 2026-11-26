import { UTS_DPOP_ALGORITHMS } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { EmbeddedJWK, calculateJwkThumbprint, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * DPoP proof verification at the authorization server (RFC 9449, section 4.3). The token
 * endpoint verifies one proof per call, before it reads the grant; the grant statement then
 * records the proof's `jti` under the grant, so a proof is accepted once (design 5.7).
 */

/** Design 7 allows 60 seconds of clock skew; a proof is accepted while its `iat` is that close. */
const DPOP_IAT_WINDOW_SECONDS = 60;

const DPOP_TYPE = 'dpop+jwt';
/** A proof holds one public key and a few claims; anything larger is refused unread. */
const MAX_PROOF_LENGTH = 4096;

const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

/** The two key types the accepted algorithms use, public members only. */
const PublicJwkSchema = z
  .union([
    z.looseObject({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: Base64Url32 }),
    z.looseObject({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: Base64Url32,
      y: Base64Url32,
    }),
  ])
  .refine(jwk => PRIVATE_JWK_MEMBERS.every(member => !(member in jwk)), 'a private key');

const HeaderSchema = z.looseObject({
  typ: z.literal(DPOP_TYPE),
  alg: z.enum(UTS_DPOP_ALGORITHMS),
  jwk: PublicJwkSchema,
});

/** RFC 9449 asks for enough entropy and warns against large values; visible ASCII, 16 to 128. */
const ClaimsSchema = z.looseObject({
  jti: z.string().regex(/^[\x21-\x7e]{16,128}$/),
  htm: z.string(),
  htu: z.string(),
  iat: z.number().int(),
});

export type DpopProof = {
  /** RFC 7638 SHA-256 thumbprint of the proof key, as the raw 32 bytes the grant stores. */
  jkt: Uint8Array;
  jti: string;
};

export type DpopCheck =
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; proof: DpopProof };

/** RFC 9449, section 4.3, item 9: compare without the query and the fragment. */
function withoutQuery(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return `${parsed.origin}${parsed.pathname}`;
}

/**
 * Verifies the request's `DPoP` header for `method` at `url` (the endpoint's URL on the issuer
 * origin, never the request's own host). One header value only, a public Ed25519 or P-256 key in
 * the header, a valid signature, the method and URL, and an `iat` within 60 seconds of now.
 */
export async function verifyDpopProof(
  request: Request,
  method: string,
  url: string,
  nowSeconds: number
): Promise<DpopCheck> {
  const value = request.headers.get('DPoP');
  if (value === null) return { status: 'missing' };
  // Headers joins repeated fields with ", ", and a compact JWS never holds a comma.
  if (value.includes(',')) return { status: 'invalid', reason: 'more than one DPoP header' };
  if (value.length > MAX_PROOF_LENGTH) return { status: 'invalid', reason: 'proof too large' };

  let header: z.output<typeof HeaderSchema>;
  let claims: z.output<typeof ClaimsSchema>;
  try {
    const parsedHeader = HeaderSchema.safeParse(decodeProtectedHeader(value));
    if (!parsedHeader.success) return { status: 'invalid', reason: 'proof header' };
    header = parsedHeader.data;
    const verified = await jwtVerify(value, EmbeddedJWK, {
      typ: DPOP_TYPE,
      algorithms: [...UTS_DPOP_ALGORITHMS],
    });
    const parsedClaims = ClaimsSchema.safeParse(verified.payload);
    if (!parsedClaims.success) return { status: 'invalid', reason: 'proof claims' };
    claims = parsedClaims.data;
  } catch {
    return { status: 'invalid', reason: 'proof signature' };
  }

  if (claims.htm !== method) return { status: 'invalid', reason: 'htm' };
  if (withoutQuery(claims.htu) !== withoutQuery(url)) return { status: 'invalid', reason: 'htu' };
  if (Math.abs(claims.iat - nowSeconds) > DPOP_IAT_WINDOW_SECONDS) {
    return { status: 'invalid', reason: 'iat' };
  }
  // The RFC 7638 members only, so the thumbprint ignores every optional member of the key.
  const { jwk } = header;
  const thumbprint = await calculateJwkThumbprint(
    jwk.kty === 'OKP'
      ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
      : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    'sha256'
  );
  return { status: 'valid', proof: { jkt: Buffer.from(thumbprint, 'base64url'), jti: claims.jti } };
}

/** The raw thumbprint a `dpop_jkt` authorization parameter names (RFC 9449, section 10). */
export function jktOfParameter(value: string): Uint8Array | null {
  return Base64Url32.safeParse(value).success ? Buffer.from(value, 'base64url') : null;
}
