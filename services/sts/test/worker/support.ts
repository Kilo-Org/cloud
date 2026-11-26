import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';

export type TestProvider = {
  issuer: string;
  audience: string;
  privateKey: CryptoKey;
  jwks: { keys: JWK[] };
};

/** How the fake provider answers one endpoint: normally, with an HTTP error, or not at all. */
export type ProviderFault = 'none' | 'error' | 'unreachable';

export type CountingFetch = {
  fetch: typeof fetch;
  calls: Map<string, number>;
  faults: { discovery: ProviderFault; jwks: ProviderFault };
};

/** A local provider: a fresh RS256 key pair plus the discovery and JWKS documents it serves. */
export async function createProvider(issuer: string, audience: string): Promise<TestProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    issuer,
    audience,
    privateKey,
    jwks: { keys: [{ ...publicJwk, kid: `${issuer}-key`, alg: 'RS256', use: 'sig' }] },
  };
}

export async function signToken(
  provider: TestProvider,
  claims: JWTPayload,
  options?: {
    audience?: string | string[];
    issuer?: string;
    /** Seconds since the epoch; default now; `null` leaves `iat` out. */
    issuedAt?: number | null;
    /** Seconds since the epoch; default 10 minutes from now; `null` leaves `exp` out. */
    expiresAt?: number | null;
  }
): Promise<string> {
  const token = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: `${provider.issuer}-key` })
    .setIssuer(options?.issuer ?? provider.issuer)
    .setAudience(options?.audience ?? provider.audience);
  if (options?.issuedAt !== null) token.setIssuedAt(options?.issuedAt);
  if (options?.expiresAt !== null) token.setExpirationTime(options?.expiresAt ?? '10m');
  return await token.sign(provider.privateKey);
}

function answer(fault: ProviderFault, body: unknown): Response {
  if (fault === 'unreachable') throw new TypeError('network connection lost');
  if (fault === 'error') return new Response('upstream unavailable', { status: 503 });
  return Response.json(body);
}

export function providerFetch(providers: TestProvider[]): CountingFetch {
  const calls = new Map<string, number>();
  const faults: CountingFetch['faults'] = { discovery: 'none', jwks: 'none' };
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.set(url, (calls.get(url) ?? 0) + 1);
    for (const provider of providers) {
      if (url === `${provider.issuer}/.well-known/openid-configuration`) {
        return answer(faults.discovery, {
          issuer: provider.issuer,
          jwks_uri: `${provider.issuer}/.well-known/jwks`,
        });
      }
      if (url === `${provider.issuer}/.well-known/jwks`) return answer(faults.jwks, provider.jwks);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls, faults };
}
