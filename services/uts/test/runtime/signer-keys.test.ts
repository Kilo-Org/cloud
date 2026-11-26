import { createExecutionContext } from 'cloudflare:test';
import { signerOfTokenKid, UTS_ENDPOINTS, UTS_SIGNER_COUNT } from '@kilocode/uts-contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_SET_SHARD_COUNT } from '../../src/dos/stubs';
import { handleRequest } from '../../src/http';
import { SIGNER_KEYS_COPY_MS, signerKeysRead } from '../../src/signer-keys';
import {
  feedAnswer,
  keySet,
  readSignerKeys,
  resetAllSigners,
  resetKeySetShards,
  resetSigner,
} from './support';
import { config, env } from './test-env';

const FEED_PROPS = { caller: 'uts-feed-local' };

beforeAll(async () => {
  await resetAllSigners();
});

beforeEach(async () => {
  await resetKeySetShards();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function answerAt(at: number) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return await feedAnswer();
  } finally {
    clock.mockRestore();
  }
}

describe('SignerKeys entrypoint reads', () => {
  it('answers the feed caller with every signer exactly once, each read now', async () => {
    const before = Date.now();
    const answer = await feedAnswer();
    expect(answer.signers.map(entry => entry.signer)).toEqual(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, index) => index)
    );
    for (const entry of answer.signers) {
      if (entry.status !== 'ok') throw new Error(`signer ${entry.signer} answered ${entry.status}`);
      expect(entry.readAt).toBeGreaterThanOrEqual(before);
    }
  });

  it("answers from its shard's copy for 2 seconds, then the shard reads the signer objects again", async () => {
    const t0 = Date.now();
    const first = await answerAt(t0);
    await resetSigner(0);
    expect(await answerAt(t0 + SIGNER_KEYS_COPY_MS - 1)).toEqual(first);
    const next = await answerAt(t0 + SIGNER_KEYS_COPY_MS);
    expect(next.signers[0]).not.toEqual(first.signers[0]);
    expect(next.signers[0]).toMatchObject({ status: 'ok', readAt: t0 + SIGNER_KEYS_COPY_MS });
    expect(next.signers[1]).toMatchObject({ status: 'ok', readAt: t0 + SIGNER_KEYS_COPY_MS });
  });

  it('reads the signers at most once per shard per 2 seconds, however many isolates ask', async () => {
    // 200 feed isolates, each on the shard its own isolate drew, all asking at once.
    const started = Date.now();
    const reads = await Promise.all(
      Array.from({ length: 200 }, async (_, isolate) => ({
        shard: isolate % KEY_SET_SHARD_COUNT,
        read: await signerKeysRead(env, config, FEED_PROPS, isolate % KEY_SET_SHARD_COUNT),
      }))
    );
    const elapsed = Date.now() - started;
    // Every answer of one shard read carries that read's start as each signer's `readAt`, so the
    // distinct read times of a shard count its signer reads.
    const readTimes = new Map<number, Set<number>>();
    for (const { shard, read } of reads) {
      if (read.status !== 'answered') throw new Error(`shard ${shard} answered ${read.status}`);
      const first = read.answer.signers[0];
      if (first?.status !== 'ok') throw new Error(`shard ${shard} has no keys for signer 0`);
      readTimes.set(shard, (readTimes.get(shard) ?? new Set()).add(first.readAt));
    }
    expect(readTimes.size).toBe(KEY_SET_SHARD_COUNT);
    const allowed = Math.floor(elapsed / SIGNER_KEYS_COPY_MS) + 1;
    for (const times of readTimes.values()) expect(times.size).toBeLessThanOrEqual(allowed);
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

  it('refuses another caller and a binding without props, and the internet gets 404 for the old route path', async () => {
    expect(await readSignerKeys(env.OTHER_MINT)).toEqual({ status: 'refused' });
    expect(await readSignerKeys(env.PROPLESS_MINT)).toEqual({ status: 'refused' });
    const internet = await handleRequest(
      new Request(`${config.endpoints.issuer}/internal/signer-keys`),
      env,
      createExecutionContext()
    );
    expect(internet.status).toBe(404);
    expect(await internet.json()).toEqual({ error: 'not_found' });
  });

  it('answers misconfigured when its shard refuses to load under the name it is asked by', async () => {
    // Staging names in a development Worker: the shard refuses, as after a wrong deploy.
    const staging = {
      ...config,
      environment: 'staging' as const,
      endpoints: UTS_ENDPOINTS.staging,
    };
    expect(await signerKeysRead(env, staging, { caller: 'uts-feed-staging' }, 0)).toEqual({
      status: 'misconfigured',
    });
  });
});
