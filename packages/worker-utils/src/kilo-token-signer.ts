import { SignJWT } from 'jose';
import type { JWTPayload } from 'jose';
import type { KiloTokenIssuerId } from './kilo-token-issuers';

export type KiloTokenSigner = {
  readonly issuer: KiloTokenIssuerId;
  /** Signs the payload as given; it must already carry `iat`, `exp` and any `aud`. */
  sign(payload: JWTPayload): Promise<string>;
};

/**
 * Signs with the shared HS256 secret, as every Kilo token is signed today.
 * HS256 tokens carry no issuer, so `issuer` only names the deployable and its
 * policy is not enforced here.
 */
export function createLegacyHs256KiloTokenSigner(
  issuer: KiloTokenIssuerId,
  secret: string
): KiloTokenSigner {
  const key = new TextEncoder().encode(secret);
  return {
    issuer,
    sign: payload =>
      new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key),
  };
}
