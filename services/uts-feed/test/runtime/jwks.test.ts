import {
  tokenKid,
  UTS_SIGNER_COUNT,
  UtsJwksSchema,
  type SignerKeysBinding,
  type SignerPublicKeys,
} from '@kilocode/uts-contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import { forgetKeySet, KEY_SET_FRESH_MS, readKeySet } from '../../src/jwks';

/** A synthetic base64url value of 32 bytes; the feed Worker checks shape, not curve points. */
function base64Url32(seed: number): string {
  return `${String(seed).padStart(4, '0')}${'A'.repeat(39)}`;
}

function signerKeys(signer: number): SignerPublicKeys {
  return {
    signer,
    keys: [0, 1].map(slot => {
      const x = base64Url32(signer * 10 + slot);
      return { kty: 'OKP', crv: 'Ed25519', x, kid: tokenKid(signer, x), alg: 'EdDSA', use: 'sig' };
    }),
  };
}

const allSigners = () =>
  Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => signerKeys(signer));

/** A signer-keys binding that answers `answer` and counts calls. */
function binding(answer: () => Promise<unknown>): SignerKeysBinding & { calls: number } {
  const fake = {
    calls: 0,
    publicKeys: async () => {
      fake.calls += 1;
      return await answer();
    },
  };
  return fake;
}

/** The development feed Worker, with the signer-keys binding the test supplies. */
function envWith(signerKeysBinding: SignerKeysBinding): Env {
  return { UTS_ENVIRONMENT: 'development', UTS_SIGNER_KEYS: signerKeysBinding };
}

const jwksRequest = (init?: RequestInit) =>
  new Request('http://localhost:8801/.well-known/jwks.json', init);

beforeEach(() => {
  forgetKeySet();
});

describe('key set endpoint', () => {
  it('serves the 32 keys of the 16 signers with the key-set cache header', async () => {
    const mint = binding(async () => ({ status: 'ok', signers: allSigners() }));
    const response = await handleRequest(jwksRequest(), envWith(mint));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('max-age=300, stale-if-error=86400');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const jwks = UtsJwksSchema.parse(await response.json());
    expect(jwks.keys).toHaveLength(32);
  });

  it('answers 503 with Retry-After when the mint Worker call fails, and tries again next time', async () => {
    let fail = true;
    const mint = binding(async () => {
      if (fail) throw new Error('network connection lost');
      return { status: 'ok', signers: allSigners() };
    });
    const failed = await handleRequest(jwksRequest(), envWith(mint));
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('30');
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(await failed.json()).toEqual({ error: 'temporarily_unavailable' });
    fail = false;
    expect((await handleRequest(jwksRequest(), envWith(mint))).status).toBe(200);
    expect(mint.calls).toBe(2);
  });

  it('answers 500 when the mint Worker refuses this caller', async () => {
    const response = await handleRequest(
      jwksRequest(),
      envWith(binding(async () => ({ status: 'denied' })))
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });

  it('answers 500 for an answer without every signer or with a private key part', async () => {
    const missing = binding(async () => ({ status: 'ok', signers: allSigners().slice(1) }));
    expect((await handleRequest(jwksRequest(), envWith(missing))).status).toBe(500);
    const withPrivate = allSigners();
    withPrivate[0] = {
      ...signerKeys(0),
      keys: signerKeys(0).keys.map(key => ({ ...key, d: base64Url32(1) })),
    };
    const leaking = binding(async () => ({ status: 'ok', signers: withPrivate }));
    expect((await handleRequest(jwksRequest(), envWith(leaking))).status).toBe(500);
  });

  it('answers 500 for a duplicate kid', async () => {
    const duplicated = allSigners();
    const [first] = signerKeys(3).keys;
    duplicated[3] = { signer: 3, keys: [first, first] };
    const mint = binding(async () => ({ status: 'ok', signers: duplicated }));
    expect((await handleRequest(jwksRequest(), envWith(mint))).status).toBe(500);
  });

  it('answers 404 to other paths and 405 to other methods', async () => {
    const mint = binding(async () => ({ status: 'ok', signers: allSigners() }));
    const other = await handleRequest(new Request('http://localhost:8801/'), envWith(mint));
    expect(other.status).toBe(404);
    const post = await handleRequest(jwksRequest({ method: 'POST' }), envWith(mint));
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
    expect(mint.calls).toBe(0);
  });
});

describe('key set reads', () => {
  it('reads the mint Worker once per freshness window', async () => {
    const mint = binding(async () => ({ status: 'ok', signers: allSigners() }));
    const start = 1_000_000;
    expect((await readKeySet(mint, 'development', start)).status).toBe('ok');
    expect((await readKeySet(mint, 'development', start + KEY_SET_FRESH_MS - 1)).status).toBe('ok');
    expect(mint.calls).toBe(1);
    expect((await readKeySet(mint, 'development', start + KEY_SET_FRESH_MS)).status).toBe('ok');
    expect(mint.calls).toBe(2);
  });

  it('never serves one environment the key set read for another', async () => {
    const mint = binding(async () => ({ status: 'ok', signers: allSigners() }));
    await readKeySet(mint, 'staging', 1_000_000);
    await readKeySet(mint, 'production', 1_000_001);
    expect(mint.calls).toBe(2);
  });

  it('keeps the newer key set when an older read finishes late', async () => {
    const newer = allSigners();
    newer[0] = { signer: 0, keys: [signerKeys(0).keys[0]] };
    const { promise: oldAnswer, resolve: releaseOld } = Promise.withResolvers<void>();
    const slow = binding(async () => {
      await oldAnswer;
      return { status: 'ok', signers: allSigners() };
    });
    const fast = binding(async () => ({ status: 'ok', signers: newer }));

    const late = readKeySet(slow, 'development', 1_000_000);
    const current = await readKeySet(fast, 'development', 1_000_500);
    releaseOld();
    expect((await late).status).toBe('ok');

    const held = await readKeySet(fast, 'development', 1_000_600);
    expect(held).toEqual(current);
    expect(fast.calls).toBe(1);
  });
});
