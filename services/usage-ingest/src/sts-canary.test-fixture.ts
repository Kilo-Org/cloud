// Test-only STS stand-in pieces for the canary tests: an Ed25519 key, its key set, and service
// tokens shaped as STS signs them (services/sts/src/dos/TokenSignerDO.ts). Web Crypto only, so the
// workerd fixture uses it too.

export type TestSigner = { kid: string; privateKey: CryptoKey; jwks: { keys: JsonWebKey[] } };

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function testSigner(kid = 'test-kid'): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    jwks: {
      keys: [
        { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid, alg: 'EdDSA', use: 'sig' } as JsonWebKey,
      ],
    },
  };
}

export async function signToken(
  signer: Pick<TestSigner, 'kid' | 'privateKey'>,
  claims: Record<string, unknown>
): Promise<string> {
  const input = `${encodeJson({ alg: 'EdDSA', typ: 'at+jwt', kid: signer.kid })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    'Ed25519',
    signer.privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

/** STS's claims for a service token of `workload` for `audience`; `environment` defaults to production. */
export function serviceClaims(input: {
  issuer: string;
  workload: string;
  audience: string;
  scope: string;
  environment?: string;
  issuedAt?: number;
  lifetimeSeconds?: number;
}): Record<string, unknown> {
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000);
  return {
    iss: input.issuer,
    sub: `service:${input.workload}`,
    client_id: input.workload,
    req: input.workload,
    env: input.environment ?? 'production',
    aud: input.audience,
    scope: input.scope,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + (input.lifetimeSeconds ?? 300),
  };
}
