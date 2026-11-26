import { Buffer } from 'node:buffer';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { jktOfParameter, verifyDpopProof } from '../../src/oauth/dpop';

const TOKEN_URL = 'https://uts.kiloapps.io/token';
const NOW = 1_800_000_000;

type ProofOptions = {
  alg?: 'EdDSA' | 'ES256';
  typ?: string;
  htm?: string;
  htu?: string;
  iat?: number;
  jti?: string;
  privateMembers?: boolean;
};

async function proof(options: ProofOptions = {}) {
  const alg = options.alg ?? 'EdDSA';
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(options.privateMembers === true ? privateKey : publicKey);
  const token = await new SignJWT({
    jti: options.jti ?? crypto.randomUUID(),
    htm: options.htm ?? 'POST',
    htu: options.htu ?? TOKEN_URL,
    iat: options.iat ?? NOW,
  })
    .setProtectedHeader({ alg, typ: options.typ ?? 'dpop+jwt', jwk })
    .sign(privateKey);
  return { token, thumbprint: await calculateJwkThumbprint(await exportJWK(publicKey), 'sha256') };
}

const request = (...values: string[]) => {
  const headers = new Headers();
  for (const value of values) headers.append('DPoP', value);
  return new Request(TOKEN_URL, { method: 'POST', headers });
};

const verify = (input: Request, url = TOKEN_URL) => verifyDpopProof(input, 'POST', url, NOW);

describe('DPoP proof verification', () => {
  it.each(['EdDSA', 'ES256'] as const)(
    'accepts a %s proof and returns its key thumbprint',
    async alg => {
      const { token, thumbprint } = await proof({ alg });
      const check = await verify(request(token));
      if (check.status !== 'valid') throw new Error(JSON.stringify(check));
      expect(Buffer.from(check.proof.jkt).toString('base64url')).toBe(thumbprint);
      expect(check.proof.iat).toBe(NOW);
    }
  );

  it('answers missing without a header', async () => {
    expect(await verify(new Request(TOKEN_URL, { method: 'POST' }))).toEqual({ status: 'missing' });
  });

  it('ignores the query of htu and refuses another path or host', async () => {
    expect((await verify(request((await proof({ htu: `${TOKEN_URL}?a=1` })).token))).status).toBe(
      'valid'
    );
    const other = await proof({ htu: 'https://uts.kiloapps.io/revoke' });
    expect(await verify(request(other.token))).toEqual({ status: 'invalid', reason: 'htu' });
    const host = await proof({ htu: 'https://evil.example.com/token' });
    expect(await verify(request(host.token))).toEqual({ status: 'invalid', reason: 'htu' });
  });

  it.each([
    ['another method', { htm: 'GET' }, 'htm'],
    ['an iat over 60 seconds old', { iat: NOW - 61 }, 'iat'],
    ['an iat over 60 seconds ahead', { iat: NOW + 61 }, 'iat'],
    ['a short jti', { jti: 'short' }, 'proof claims'],
    ['another typ', { typ: 'JWT' }, 'proof header'],
    ['a private key in the header', { privateMembers: true }, 'proof header'],
  ] satisfies [string, ProofOptions, string][])('refuses %s', async (_name, options, reason) => {
    expect(await verify(request((await proof(options)).token))).toEqual({
      status: 'invalid',
      reason,
    });
  });

  it('refuses two headers, a tampered signature and a symmetric algorithm', async () => {
    const { token } = await proof();
    expect((await verify(request(token, token))).status).toBe('invalid');
    const [header, payload] = token.split('.');
    const forged = `${header}.${payload}.${Buffer.alloc(64).toString('base64url')}`;
    expect(await verify(request(forged))).toEqual({ status: 'invalid', reason: 'proof signature' });
    const symmetric = await new SignJWT({
      jti: crypto.randomUUID(),
      htm: 'POST',
      htu: TOKEN_URL,
      iat: NOW,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'dpop+jwt' })
      .sign(new Uint8Array(32));
    expect(await verify(request(symmetric))).toEqual({ status: 'invalid', reason: 'proof header' });
    expect((await verify(request('x'.repeat(5000)))).status).toBe('invalid');
  });

  it('decodes a dpop_jkt parameter of 32 bytes only', () => {
    expect(jktOfParameter(Buffer.alloc(32, 1).toString('base64url'))).toEqual(Buffer.alloc(32, 1));
    expect(jktOfParameter('short')).toBeNull();
  });
});
