import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import {
  tokenKid,
  UTS_SIGNER_COUNT,
  UtsJwksSchema,
  type SignerPublicKeys,
} from '@kilocode/uts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import {
  KEY_SET_FRESH_MS,
  KEY_SET_HOLD_MS,
  KEY_SET_MAX_SERVED_AGE_MS,
  KEY_SET_READ_GUARD_MS,
  resetIsolate,
} from '../../src/jwks';

const T0 = 1_000_000_000;

/** A synthetic base64url value of 32 bytes; the feed Worker checks shape, not curve points. */
function base64Url32(seed: number): string {
  return `${String(seed).padStart(4, '0')}${'A'.repeat(39)}`;
}

function signerKeys(signer: number, generation = 0): SignerPublicKeys {
  return {
    signer,
    keys: [0, 1].map(slot => {
      const x = base64Url32(generation * 1000 + signer * 10 + slot);
      return { kty: 'OKP', crv: 'Ed25519', x, kid: tokenKid(signer, x), alg: 'EdDSA', use: 'sig' };
    }),
  };
}

const allSigners = (generation = 0) =>
  Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => signerKeys(signer, generation));

const okAnswer = (generation = 0) =>
  Response.json({ status: 'ok', signers: allSigners(generation) });

/** A mint Worker binding that answers `answer` and counts reads. */
function mintBinding(answer: () => Promise<Response>): Fetcher & { calls: number } {
  const fake = {
    calls: 0,
    fetch: async (): Promise<Response> => {
      fake.calls += 1;
      return await answer();
    },
    connect: (): Socket => {
      throw new Error('the feed Worker opens no socket to the mint Worker');
    },
  };
  return fake;
}

/** The development feed Worker, with the mint binding the test supplies. */
function envWith(mint: Fetcher, environment = 'development'): Env {
  return { UTS_ENVIRONMENT: environment, UTS_MINT: mint };
}

const jwksRequest = (init?: RequestInit) =>
  new Request('http://localhost:8801/.well-known/jwks.json', init);

/** One key-set request, with its background work finished, as if the clock read `at`. */
async function get(mint: Fetcher, at?: number, environment?: string): Promise<Response> {
  const clock = at === undefined ? null : vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const ctx = createExecutionContext();
    const response = await handleRequest(jwksRequest(), envWith(mint, environment), ctx);
    await waitOnExecutionContext(ctx);
    return response;
  } finally {
    clock?.mockRestore();
  }
}

const firstX = async (response: Response) => UtsJwksSchema.parse(await response.json()).keys[0]?.x;

beforeEach(() => {
  resetIsolate();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('key set endpoint', () => {
  it('serves the 32 keys of the 16 signers with the key-set cache header', async () => {
    const response = await get(mintBinding(async () => okAnswer()));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('max-age=300, stale-if-error=86400');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(UtsJwksSchema.parse(await response.json()).keys).toHaveLength(32);
  });

  it('answers 404 to other paths and 405 to other methods without a read', async () => {
    const mint = mintBinding(async () => okAnswer());
    const ctx = createExecutionContext();
    const other = await handleRequest(new Request('http://localhost:8801/'), envWith(mint), ctx);
    expect(other.status).toBe(404);
    const post = await handleRequest(jwksRequest({ method: 'POST' }), envWith(mint), ctx);
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
    expect(mint.calls).toBe(0);
  });
});

describe('reads', () => {
  it('makes one mint read for concurrent cold requests in an isolate', async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const mint = mintBinding(async () => {
      await release;
      return okAnswer();
    });
    const pending = Array.from({ length: 10 }, async () => {
      const ctx = createExecutionContext();
      const response = await handleRequest(jwksRequest(), envWith(mint), ctx);
      await waitOnExecutionContext(ctx);
      return response.status;
    });
    resolve();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 10 }, () => 200));
    expect(mint.calls).toBe(1);
  });

  it('shares no copy between isolates: a new isolate makes its own read', async () => {
    const mint = mintBinding(async () => okAnswer());
    expect((await get(mint, T0)).status).toBe(200);
    resetIsolate();
    expect((await get(mint, T0 + 1)).status).toBe(200);
    expect(mint.calls).toBe(2);
  });

  it('serves the held set without a read inside the fresh window', async () => {
    const mint = mintBinding(async () => okAnswer());
    await get(mint, T0);
    await get(mint, T0 + KEY_SET_FRESH_MS - 1);
    expect(mint.calls).toBe(1);
  });

  it('after the fresh window serves the held set and refreshes it once in the background', async () => {
    let generation = 0;
    const mint = mintBinding(async () => okAnswer(generation));
    await get(mint, T0);
    generation = 1;
    const stale = await get(mint, T0 + KEY_SET_FRESH_MS);
    expect(await firstX(stale)).toBe(signerKeys(0, 0).keys[0]?.x);
    expect(mint.calls).toBe(2);
    const refreshed = await get(mint, T0 + KEY_SET_FRESH_MS + 1);
    expect(await firstX(refreshed)).toBe(signerKeys(0, 1).keys[0]?.x);
    expect(mint.calls).toBe(2);
  });

  it('waits for the read once the held set is 15 seconds old, so it never serves an older set', async () => {
    let generation = 0;
    const mint = mintBinding(async () => okAnswer(generation));
    await get(mint, T0);
    generation = 1;
    const response = await get(mint, T0 + KEY_SET_MAX_SERVED_AGE_MS);
    expect(await firstX(response)).toBe(signerKeys(0, 1).keys[0]?.x);
  });

  it('never serves one environment the key set read for another', async () => {
    const mint = mintBinding(async () => okAnswer());
    await get(mint, T0, 'staging');
    await get(mint, T0 + 1, 'production');
    expect(mint.calls).toBe(2);
  });

  it('keeps the newer key set when an older read finishes late', async () => {
    const { promise: oldAnswer, resolve: releaseOld } = Promise.withResolvers<void>();
    let call = 0;
    const mint = mintBinding(async () => {
      call += 1;
      if (call === 1) {
        await oldAnswer;
        return okAnswer(0);
      }
      return okAnswer(1);
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    const lateCtx = createExecutionContext();
    const late = handleRequest(jwksRequest(), envWith(mint), lateCtx);
    clock.mockReturnValue(T0 + KEY_SET_READ_GUARD_MS);
    const newer = await handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    expect(await firstX(newer)).toBe(signerKeys(0, 1).keys[0]?.x);
    releaseOld();
    await late;
    await waitOnExecutionContext(lateCtx);
    clock.mockReturnValue(T0 + KEY_SET_READ_GUARD_MS + 1);
    const held = await handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    expect(await firstX(held)).toBe(signerKeys(0, 1).keys[0]?.x);
    expect(mint.calls).toBe(2);
  });
});

describe('failures', () => {
  it('keeps serving the held set while reads fail, for up to 24 hours', async () => {
    let fail = false;
    const mint = mintBinding(async () => {
      if (fail) throw new Error('network connection lost');
      return okAnswer();
    });
    await get(mint, T0);
    fail = true;
    expect((await get(mint, T0 + KEY_SET_MAX_SERVED_AGE_MS)).status).toBe(200);
    expect((await get(mint, T0 + KEY_SET_HOLD_MS - 1)).status).toBe(200);
    const expired = await get(mint, T0 + KEY_SET_HOLD_MS + KEY_SET_READ_GUARD_MS);
    expect(expired.status).toBe(503);
  });

  it('answers 503 with Retry-After when it holds nothing, and reads at most once per guard window', async () => {
    let fail = true;
    const mint = mintBinding(async () => {
      if (fail) throw new Error('network connection lost');
      return okAnswer();
    });
    const failed = await get(mint, T0);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('10');
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(await failed.json()).toEqual({ error: 'temporarily_unavailable' });
    expect((await get(mint, T0 + KEY_SET_READ_GUARD_MS - 1)).status).toBe(503);
    expect(mint.calls).toBe(1);
    fail = false;
    expect((await get(mint, T0 + KEY_SET_READ_GUARD_MS)).status).toBe(200);
    expect(mint.calls).toBe(2);
  });

  it('answers 503 for a mint answer that is a platform error page', async () => {
    const mint = mintBinding(
      async () => new Response('worker exceeded resource limits', { status: 503 })
    );
    expect((await get(mint)).status).toBe(503);
  });

  it('answers 503 when the mint Worker reports a signer call that failed', async () => {
    const mint = mintBinding(async () => Response.json({ status: 'unavailable' }, { status: 503 }));
    expect((await get(mint)).status).toBe(503);
  });

  it('answers 500 when the mint Worker refuses this caller or a signer object is misconfigured', async () => {
    for (const answer of [
      () => Response.json({ error: 'not_found' }, { status: 404 }),
      () => Response.json({ status: 'misconfigured' }, { status: 500 }),
    ]) {
      resetIsolate();
      const response = await get(mintBinding(async () => answer()));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'server_error' });
    }
  });

  it('answers 500 for an answer without every signer, with a private key part, or with a duplicate kid', async () => {
    const missing = { status: 'ok', signers: allSigners().slice(1) };
    const withPrivate = allSigners();
    withPrivate[0] = {
      ...signerKeys(0),
      keys: signerKeys(0).keys.map(key => ({ ...key, d: base64Url32(1) })),
    };
    const duplicated = allSigners();
    const [first] = signerKeys(3).keys;
    duplicated[3] = { signer: 3, keys: [first, first] };
    for (const body of [
      missing,
      { status: 'ok', signers: withPrivate },
      { status: 'ok', signers: duplicated },
    ]) {
      resetIsolate();
      expect((await get(mintBinding(async () => Response.json(body)))).status).toBe(500);
    }
  });
});
