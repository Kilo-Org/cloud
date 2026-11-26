import { createExecutionContext } from 'cloudflare:test';
import {
  SignerKeysAnswerSchema,
  signerOfTokenKid,
  UTS_ENDPOINTS,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_PATH,
} from '@kilocode/uts-contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../../src/http';
import {
  resetSignerKeysIsolate,
  SIGNER_KEYS_COPY_MS,
  signerKeysResponse,
} from '../../src/signer-keys';
import { fetchSignerKeys, keySet, resetAllSigners, resetSigner } from './support';
import { config, env } from './test-env';

beforeAll(async () => {
  await resetAllSigners();
});

beforeEach(() => {
  resetSignerKeysIsolate();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signerKeysUrl = `${config.endpoints.issuer}${UTS_SIGNER_KEYS_PATH}`;

async function answerAt(at: number) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return SignerKeysAnswerSchema.parse(await (await fetchSignerKeys()).json());
  } finally {
    clock.mockRestore();
  }
}

describe('internal signer-keys route', () => {
  it('answers the feed caller with every signer exactly once, each read now', async () => {
    const before = Date.now();
    const response = await fetchSignerKeys();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const answer = SignerKeysAnswerSchema.parse(await response.json());
    expect(answer.signers.map(entry => entry.signer)).toEqual(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, index) => index)
    );
    for (const entry of answer.signers) {
      if (entry.status !== 'ok') throw new Error(`signer ${entry.signer} answered ${entry.status}`);
      expect(entry.readAt).toBeGreaterThanOrEqual(before);
    }
  });

  it("answers from the isolate's copy for 2 seconds, then reads the signer objects again", async () => {
    const t0 = Date.now();
    const first = await answerAt(t0);
    await resetSigner(0);
    expect(await answerAt(t0 + SIGNER_KEYS_COPY_MS - 1)).toEqual(first);
    const next = await answerAt(t0 + SIGNER_KEYS_COPY_MS);
    expect(next.signers[0]).not.toEqual(first.signers[0]);
    expect(next.signers[0]).toMatchObject({ status: 'ok', readAt: t0 + SIGNER_KEYS_COPY_MS });
    expect(next.signers[1]).toMatchObject({ status: 'ok', readAt: t0 + SIGNER_KEYS_COPY_MS });
  });

  it('builds a key set of 32 keys: the current and next key of all 16 signers', async () => {
    const { keys } = await keySet();
    expect(keys).toHaveLength(32);
    const perSigner = new Map<number | null, number>();
    for (const key of keys) {
      const signer = signerOfTokenKid(key.kid);
      perSigner.set(signer, (perSigner.get(signer) ?? 0) + 1);
    }
    expect([...perSigner.values()]).toEqual(Array.from({ length: UTS_SIGNER_COUNT }, () => 2));
  });

  it('answers another caller, a binding without props and an internet request as an unknown path', async () => {
    for (const response of [
      await fetchSignerKeys(env.OTHER_MINT),
      await fetchSignerKeys(env.PROPLESS_MINT),
      await handleRequest(new Request(signerKeysUrl), env, createExecutionContext()),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('answers 405 to the feed caller for another method', async () => {
    const response = await env.FEED_MINT.fetch(signerKeysUrl, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('answers 500 with each signer misconfigured when the objects refuse to load under the names it reads', async () => {
    // Staging names in a development Worker: every object refuses, as after a wrong deploy.
    const staging = {
      ...config,
      environment: 'staging' as const,
      endpoints: UTS_ENDPOINTS.staging,
    };
    const response = await signerKeysResponse(new Request(signerKeysUrl), env, staging, {
      caller: 'uts-feed-staging',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      signers: Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => ({
        signer,
        status: 'misconfigured',
      })),
    });
  });
});
