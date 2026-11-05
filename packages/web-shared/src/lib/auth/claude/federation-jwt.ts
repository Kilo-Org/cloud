import 'server-only';
import { randomUUID, createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * Kilo's own identity provider for Claude Platform OAuth.
 *
 * Anthropic issues no client secrets. Kilo's back end proves who it is with a
 * short-lived JWT that Kilo signs with its own ES256 key. Anthropic holds the
 * public key as an inline JWKS on a federation issuer whose issuer URL is
 * `CLAUDE_FEDERATION_ISSUER`, compared as a string.
 *
 * The same signer produces the client assertion for the OAuth apps' PAR and
 * token endpoints and the identity token that the operator service account
 * exchanges for an API token. Only the audience and lifetime differ.
 *
 * Each JWT carries a fresh `jti`, because Anthropic accepts a JWT with a `jti`
 * only once.
 */

const ALGORITHM = 'ES256';

type FederationSigner = {
  issuer: string;
  subject: string;
  keyId: string;
  privateKey: KeyObject;
};

let cachedSigner: FederationSigner | null = null;

export class ClaudeFederationConfigError extends Error {
  override readonly name = 'ClaudeFederationConfigError';
}

function loadSigner(): FederationSigner {
  if (cachedSigner) return cachedSigner;

  const issuer = getEnvVariable('CLAUDE_FEDERATION_ISSUER');
  const subject = getEnvVariable('CLAUDE_FEDERATION_SUBJECT');
  const keyId = getEnvVariable('CLAUDE_FEDERATION_KEY_ID');
  const pem = getEnvVariable('CLAUDE_FEDERATION_PRIVATE_KEY');
  if (!issuer || !subject || !keyId || !pem) {
    throw new ClaudeFederationConfigError('Claude federation signing is not configured');
  }

  const privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new ClaudeFederationConfigError('CLAUDE_FEDERATION_PRIVATE_KEY must be a P-256 key');
  }

  cachedSigner = { issuer, subject, keyId, privateKey };
  return cachedSigner;
}

export type ClaudeFederationJwtOptions = {
  /** The one audience the receiving OAuth app or federation rule expects. */
  audience: string;
  lifetimeSeconds: number;
};

/** Signs a fresh Kilo federation JWT. */
export async function signClaudeFederationJwt({
  audience,
  lifetimeSeconds,
}: ClaudeFederationJwtOptions): Promise<string> {
  if (!audience) {
    throw new ClaudeFederationConfigError('Claude federation audience is not configured');
  }
  const signer = loadSigner();
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, kid: signer.keyId, typ: 'JWT' })
    .setIssuer(signer.issuer)
    .setSubject(signer.subject)
    // A string, not an array: auth.claude.com rejects more than one audience.
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSeconds)
    .setJti(randomUUID())
    .sign(signer.privateKey);
}

/**
 * Lifetime of a client assertion. Anyone who intercepts one can use it until it
 * expires, so it covers one request plus clock skew.
 */
export const CLAUDE_CLIENT_ASSERTION_LIFETIME_SECONDS = 300;
