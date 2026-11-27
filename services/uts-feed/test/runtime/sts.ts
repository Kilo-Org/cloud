import { UTS_FEED_AUDIENCE, UTS_FEED_READ_SCOPE } from '@kilocode/uts-contracts';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { vi } from 'vitest';

/**
 * A stand-in STS for the HTTPS feed tests: one Ed25519 key, its key set served at a loopback
 * issuer through a `fetch` spy, and service tokens in the STS profile (`@kilocode/sts-contracts`)
 * that `@kilocode/verify` checks. Synthetic keys only.
 */

export const TEST_STS_ISSUER = 'http://127.0.0.1:9409';
const KID = 'sts-test-0';

let keys: Promise<{ privateKey: CryptoKey; jwk: JWK }> | null = null;

async function stsKeys(): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  keys ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'EdDSA', use: 'sig' };
    return { privateKey: pair.privateKey, jwk };
  })();
  return await keys;
}

type TokenOptions = {
  workload?: string;
  audience?: string;
  scope?: string;
  environment?: string;
  issuer?: string;
  /** Issued 5 minutes ago and expired 2 minutes ago, past the 60-second skew. */
  expired?: boolean;
  /** Signs with a fresh key that the served key set does not hold. */
  foreignKey?: boolean;
};

export async function stsToken(options: TokenOptions = {}): Promise<string> {
  const workload = options.workload ?? 'web';
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.expired ? now - 300 : now;
  const signingKey = options.foreignKey
    ? (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey
    : (await stsKeys()).privateKey;
  return await new SignJWT({
    client_id: workload,
    req: workload,
    scope: options.scope ?? UTS_FEED_READ_SCOPE,
    env: options.environment ?? 'development',
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })
    .setIssuer(options.issuer ?? TEST_STS_ISSUER)
    .setAudience(options.audience ?? UTS_FEED_AUDIENCE)
    .setSubject(`service:${workload}`)
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expired ? now - 120 : issuedAt + 300)
    .sign(signingKey);
}

/**
 * Serves the key set at `TEST_STS_ISSUER` through a `fetch` spy and counts each fetch of it;
 * `available: false` makes every key-set fetch fail. Restored by `vi.restoreAllMocks()`.
 */
export async function serveStsKeySet(options: { available?: boolean } = {}) {
  const { jwk } = await stsKeys();
  const fetched: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (options.available === false) throw new Error('connection refused');
    if (url === `${TEST_STS_ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    return new Response(null, { status: 404 });
  });
  return { fetched };
}
