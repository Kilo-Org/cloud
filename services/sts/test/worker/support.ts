import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';

export type TestProvider = {
  issuer: string;
  audience: string;
  privateKey: CryptoKey;
  jwks: { keys: JWK[] };
  id: string;
};

export type CountingFetch = {
  fetch: typeof fetch;
  calls: Map<string, number>;
};

/** A local provider: a fresh RS256 key pair plus the discovery and JWKS documents it serves. */
export async function createProvider(issuer: string, audience: string): Promise<TestProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    id: issuer,
    issuer,
    audience,
    privateKey,
    jwks: { keys: [{ ...publicJwk, kid: `${issuer}-key`, alg: 'RS256', use: 'sig' }] },
  };
}

export async function signToken(
  provider: TestProvider,
  claims: JWTPayload,
  options?: { audience?: string; issuer?: string }
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: `${provider.issuer}-key` })
    .setIssuer(options?.issuer ?? provider.issuer)
    .setAudience(options?.audience ?? provider.audience)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(provider.privateKey);
}

export function providerFetch(providers: TestProvider[]): CountingFetch {
  const calls = new Map<string, number>();
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.set(url, (calls.get(url) ?? 0) + 1);
    for (const provider of providers) {
      if (url === `${provider.issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: provider.issuer,
          jwks_uri: `${provider.issuer}/.well-known/jwks`,
        });
      }
      if (url === `${provider.issuer}/.well-known/jwks`) {
        return Response.json(provider.jwks);
      }
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}
