import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import {
  tokenKid,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  UtsJwksSchema,
  type SignerKeysBinding,
  type SignerKeysEntry,
} from '@kilocode/uts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { handleRequest } from '../../src/http';
import {
  KEY_SET_FRESH_MS,
  KEY_SET_MAX_SERVED_AGE_MS,
  KEY_SET_READ_GUARD_MS,
  resetIsolate,
} from '../../src/jwks';

const T0 = 1_000_000_000_000;

/** A synthetic base64url value of 32 bytes; the feed Worker checks shape, not curve points. */
function base64Url32(seed: number): string {
  return `${String(seed).padStart(4, '0')}${'A'.repeat(39)}`;
}

type OkEntry = Extract<SignerKeysEntry, { status: 'ok' }>;

/** Signer `signer`'s two keys of `generation`, as its object answered at `readAt`. */
function signerEntry(signer: number, generation = 0, readAt = Date.now()): OkEntry {
  return {
    signer,
    status: 'ok',
    keys: [0, 1].map(slot => {
      const x = base64Url32(generation * 1000 + signer * 10 + slot);
      return { kty: 'OKP', crv: 'Ed25519', x, kid: tokenKid(signer, x), alg: 'EdDSA', use: 'sig' };
    }),
    readAt,
  };
}

const allSigners = (generation = 0, readAt = Date.now()): SignerKeysEntry[] =>
  Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => signerEntry(signer, generation, readAt));

type MintResult = Record<string, unknown> & Partial<Disposable>;

/** A `signerKeys()` result that carries `signers` as the mint Worker's answer. */
const answered = (signers: unknown[]): MintResult => ({ status: 'answered', answer: { signers } });

const okAnswer = (generation = 0, readAt = Date.now()) => answered(allSigners(generation, readAt));

/** Every signer failed with `status`, as the mint Worker answers when it holds no keys. */
const failedAnswer = (status: 'misconfigured' | 'unavailable') =>
  answered(Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => ({ signer, status })));

/** A mint Worker binding whose `signerKeys()` answers `answer`, counting its calls. */
function mintBinding(answer: () => Promise<MintResult>): SignerKeysBinding & { calls: number } {
  const fake = {
    calls: 0,
    signerKeys: async (): Promise<MintResult> => {
      fake.calls += 1;
      return await answer();
    },
  };
  return fake;
}

/** The development feed Worker, with the mint binding the test supplies. */
function envWith(mint: SignerKeysBinding, environment = 'development'): Env {
  return { UTS_ENVIRONMENT: environment, UTS_MINT: mint };
}

const jwksRequest = (init?: RequestInit) =>
  new Request('http://localhost:8801/.well-known/jwks.json', init);

/** One key-set request, with its background work finished, as if the clock read `at`. */
async function get(mint: SignerKeysBinding, at?: number, environment?: string): Promise<Response> {
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

const keysOf = async (response: Response) => UtsJwksSchema.parse(await response.json()).keys;

/** The `x` of each key the response lists for `signer`. */
async function xsOf(response: Response, signer: number): Promise<string[]> {
  const prefix = `uts-token-${String(signer).padStart(2, '0')}-`;
  return (await keysOf(response)).filter(key => key.kid.startsWith(prefix)).map(key => key.x);
}

const xs = (signer: number, generation: number) =>
  signerEntry(signer, generation, T0).keys.map(key => key.x);

/** The standard cache limits, with `Age` from the newest keys and the oldest keys' age beside it. */
function expectKeySetHeaders(response: Response, age: string, oldestAge: string): void {
  expect(response.headers.get('Cache-Control')).toBe('max-age=300, stale-if-error=86400');
  expect(response.headers.get('Age')).toBe(age);
  expect(response.headers.get('Kilo-Key-Set-Oldest-Age')).toBe(oldestAge);
}

beforeEach(() => {
  resetIsolate();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('key set endpoint', () => {
  it('serves the 32 keys of the 16 signers with the key-set cache header and both ages at 0', async () => {
    const response = await get(mintBinding(async () => okAnswer()));
    expect(response.status).toBe(200);
    expectKeySetHeaders(response, '0', '0');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await keysOf(response)).toHaveLength(32);
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

  it('gives up a mint read after the read guard, and disposes a result that lands later', async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const late = Promise.withResolvers<MintResult>();
      const mint = mintBinding(async () => await late.promise);
      const pending = get(mint);
      await vi.advanceTimersByTimeAsync(KEY_SET_READ_GUARD_MS);
      expect((await pending).status).toBe(503);
      const dispose = vi.fn();
      late.resolve({ ...okAnswer(), [Symbol.dispose]: dispose });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes each mint result once it holds the validated copy', async () => {
    const dispose = vi.fn();
    const mint = mintBinding(async () => ({ ...okAnswer(), [Symbol.dispose]: dispose }));
    const response = await get(mint, T0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(await keysOf(response)).toHaveLength(32);
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

  it('after the fresh window serves the held set with its Age and refreshes it once in the background', async () => {
    let generation = 0;
    const mint = mintBinding(async () => okAnswer(generation));
    await get(mint, T0);
    generation = 1;
    const stale = await get(mint, T0 + KEY_SET_FRESH_MS);
    expect(await xsOf(stale, 0)).toEqual(xs(0, 0));
    expectKeySetHeaders(stale, '10', '10');
    expect(mint.calls).toBe(2);
    const refreshed = await get(mint, T0 + KEY_SET_FRESH_MS + 1);
    expect(await xsOf(refreshed, 0)).toEqual(xs(0, 1));
    expectKeySetHeaders(refreshed, '0', '0');
    expect(mint.calls).toBe(2);
  });

  it('waits for the read once the newest keys are 17 seconds old, so it never serves older ones', async () => {
    let generation = 0;
    const mint = mintBinding(async () => okAnswer(generation));
    await get(mint, T0);
    generation = 1;
    const response = await get(mint, T0 + KEY_SET_MAX_SERVED_AGE_MS);
    expect(await xsOf(response, 0)).toEqual(xs(0, 1));
  });

  it('counts the age from the signer read behind a mint Worker copy, and still reads once per guard window', async () => {
    const mint = mintBinding(async () => okAnswer(0, Date.now() - 2000));
    await get(mint, T0);
    await get(mint, T0 + KEY_SET_FRESH_MS - 2000);
    expect(mint.calls).toBe(1);
    const response = await get(mint, T0 + KEY_SET_READ_GUARD_MS);
    expectKeySetHeaders(response, '12', '12');
    expect(mint.calls).toBe(2);
  });

  it('counts a read time from a clock ahead of its own as the arrival time', async () => {
    const mint = mintBinding(async () => okAnswer(0, Date.now() + 60_000));
    await get(mint, T0);
    await get(mint, T0 + KEY_SET_FRESH_MS);
    expect(mint.calls).toBe(2);
  });

  it('never serves one environment the key set read for another', async () => {
    const mint = mintBinding(async () => okAnswer());
    await get(mint, T0, 'staging');
    await get(mint, T0 + 1, 'production');
    expect(mint.calls).toBe(2);
  });

  it('keeps the newer keys when an older read finishes late', async () => {
    const { promise: oldAnswer, resolve: releaseOld } = Promise.withResolvers<void>();
    let call = 0;
    const mint = mintBinding(async () => {
      call += 1;
      if (call === 1) {
        await oldAnswer;
        return okAnswer(0, T0);
      }
      return okAnswer(1);
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    const lateCtx = createExecutionContext();
    const late = handleRequest(jwksRequest(), envWith(mint), lateCtx);
    clock.mockReturnValue(T0 + KEY_SET_READ_GUARD_MS);
    const newer = await handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    expect(await xsOf(newer, 0)).toEqual(xs(0, 1));
    releaseOld();
    await late;
    await waitOnExecutionContext(lateCtx);
    clock.mockReturnValue(T0 + KEY_SET_READ_GUARD_MS + 1);
    const held = await handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    expect(await xsOf(held, 0)).toEqual(xs(0, 1));
    expect(mint.calls).toBe(2);
  });

  it('lets a waiting request take the result of a read that replaced a hung one', async () => {
    let call = 0;
    const mint = mintBinding(async () => {
      call += 1;
      if (call === 1) return await new Promise<MintResult>(() => undefined);
      return okAnswer();
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    void handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    clock.mockReturnValue(T0 + 1);
    const waiter = handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    await scheduler.wait(50);
    clock.mockReturnValue(T0 + KEY_SET_READ_GUARD_MS);
    const starter = await handleRequest(jwksRequest(), envWith(mint), createExecutionContext());
    expect(starter.status).toBe(200);
    expect((await waiter).status).toBe(200);
    expect(mint.calls).toBe(2);
  });
});

describe('signers', () => {
  it("takes a healthy signer's new keys while another signer fails, and keeps the failed signer's keys", async () => {
    let failing = false;
    const mint = mintBinding(async () => {
      if (!failing) return okAnswer(0);
      const signers = allSigners(0);
      signers[3] = signerEntry(3, 1);
      signers[7] = { signer: 7, status: 'unavailable' };
      return answered(signers);
    });
    await get(mint, T0);
    failing = true;
    const response = await get(mint, T0 + 20_000);
    expect(response.status).toBe(200);
    expect(await xsOf(response.clone(), 3)).toEqual(xs(3, 1));
    expect(await xsOf(response.clone(), 7)).toEqual(xs(7, 0));
    expect(await keysOf(response.clone())).toHaveLength(32);
    expectKeySetHeaders(response, '0', '20');
  });

  it('keeps Age from the healthy signers past the 5-minute lifetime while one signer fails, and its oldest age grows', async () => {
    let failing = false;
    const mint = mintBinding(async () => {
      if (!failing) return okAnswer(0);
      const signers = allSigners(0);
      signers[7] = { signer: 7, status: 'unavailable' };
      return answered(signers);
    });
    await get(mint, T0);
    failing = true;
    expectKeySetHeaders(await get(mint, T0 + 20_000), '0', '20');
    const late = await get(mint, T0 + 400_000);
    expectKeySetHeaders(late, '0', '400');
    expect(await xsOf(late, 7)).toEqual(xs(7, 0));
    expect(mint.calls).toBe(3);
    const held = await get(mint, T0 + 405_000);
    expectKeySetHeaders(held, '5', '405');
    expect(mint.calls).toBe(3);
  });

  it('takes keys the mint Worker held for a failed signer, with their own read time', async () => {
    const mint = mintBinding(async () => {
      const signers = allSigners(0);
      signers[7] = signerEntry(7, 0, Date.now() - 3600 * 1000);
      return answered(signers);
    });
    const response = await get(mint, T0);
    expect(await xsOf(response.clone(), 7)).toEqual(xs(7, 0));
    expectKeySetHeaders(response, '0', '3600');
  });

  it("keeps its own newer keys for a signer over the mint Worker's older held ones", async () => {
    let olderHeld = false;
    const mint = mintBinding(async () => {
      const signers = allSigners(0);
      if (olderHeld) signers[7] = signerEntry(7, 2, T0 - 1000);
      return answered(signers);
    });
    await get(mint, T0);
    olderHeld = true;
    const response = await get(mint, T0 + KEY_SET_MAX_SERVED_AGE_MS);
    expect(await xsOf(response, 7)).toEqual(xs(7, 0));
  });

  it('drops a signer whose keys are 24 hours old and serves the other signers', async () => {
    let failing = false;
    const mint = mintBinding(async () => {
      if (!failing) return okAnswer(0);
      const signers = allSigners(0);
      signers[7] = { signer: 7, status: 'unavailable' };
      return answered(signers);
    });
    await get(mint, T0);
    failing = true;
    const response = await get(mint, T0 + UTS_SIGNER_KEYS_HOLD_MS);
    expect(response.status).toBe(200);
    expect(await xsOf(response.clone(), 7)).toEqual([]);
    expect(await keysOf(response)).toHaveLength(30);
  });
});

describe('failures', () => {
  it('keeps serving the held set while reads fail, with its Age, for up to 24 hours', async () => {
    let fail = false;
    const mint = mintBinding(async () => {
      if (fail) throw new Error('network connection lost');
      return okAnswer();
    });
    await get(mint, T0);
    fail = true;
    const held = await get(mint, T0 + 60_000);
    expect(held.status).toBe(200);
    expectKeySetHeaders(held, '60', '60');
    const last = await get(mint, T0 + UTS_SIGNER_KEYS_HOLD_MS - 1000);
    expect(last.status).toBe(200);
    expectKeySetHeaders(last, '86399', '86399');
    const expired = await get(mint, T0 + UTS_SIGNER_KEYS_HOLD_MS + KEY_SET_READ_GUARD_MS);
    expect(expired.status).toBe(503);
  });

  it('keeps serving the held set after any failed read: a refused caller or an invalid answer', async () => {
    for (const failure of [() => ({ status: 'refused' }), () => answered([])]) {
      resetIsolate();
      let fail = false;
      const mint = mintBinding(async () => (fail ? failure() : okAnswer()));
      await get(mint, T0);
      fail = true;
      expect((await get(mint, T0 + KEY_SET_MAX_SERVED_AGE_MS)).status).toBe(200);
      expect(mint.calls).toBe(2);
    }
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

  it('keeps no keys from a result that is not a signer-keys read', async () => {
    for (const result of [{ status: 'answered' }, { signers: allSigners() }, { status: 'other' }]) {
      resetIsolate();
      expect((await get(mintBinding(async () => result))).status).toBe(500);
    }
  });

  it('answers 503 when the mint Worker has keys for no signer', async () => {
    expect((await get(mintBinding(async () => failedAnswer('unavailable')))).status).toBe(503);
  });

  it('answers 500 when the mint Worker refuses this caller or a signer object is misconfigured', async () => {
    for (const answer of [() => ({ status: 'refused' }), () => failedAnswer('misconfigured')]) {
      resetIsolate();
      const response = await get(mintBinding(async () => answer()));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'server_error' });
    }
  });

  it('answers 500 for an answer without every signer, with a private key part, or with a duplicate kid', async () => {
    const missing = { signers: allSigners().slice(1) };
    const withPrivate = allSigners();
    const first = signerEntry(0);
    withPrivate[0] = { ...first, keys: first.keys.map(key => ({ ...key, d: base64Url32(1) })) };
    const duplicated = allSigners();
    const third = signerEntry(3);
    duplicated[3] = { ...third, keys: [...third.keys, ...third.keys] };
    for (const body of [missing, { signers: withPrivate }, { signers: duplicated }]) {
      resetIsolate();
      expect((await get(mintBinding(async () => answered(body.signers)))).status).toBe(500);
    }
  });
});
