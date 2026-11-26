import { signerOfTokenKid, UTS_ENDPOINTS, UTS_SIGNER_COUNT } from '@kilocode/uts-contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../../src/http';
import { resetSignerKeysIsolate, SIGNER_KEYS_COPY_MS, signerKeysRead } from '../../src/signer-keys';
import { feedAnswer, keySet, readSignerKeys, resetAllSigners, resetSigner } from './support';
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

  it('refuses another caller and a binding without props, and the internet gets 404 for the old route path', async () => {
    expect(await readSignerKeys(env.OTHER_MINT)).toEqual({ status: 'refused' });
    expect(await readSignerKeys(env.PROPLESS_MINT)).toEqual({ status: 'refused' });
    const internet = await handleRequest(
      new Request(`${config.endpoints.issuer}/internal/signer-keys`),
      env
    );
    expect(internet.status).toBe(404);
    expect(await internet.json()).toEqual({ error: 'not_found' });
  });

  it('answers each signer misconfigured when the objects refuse to load under the names it reads', async () => {
    // Staging names in a development Worker: every object refuses, as after a wrong deploy.
    const staging = {
      ...config,
      environment: 'staging' as const,
      endpoints: UTS_ENDPOINTS.staging,
    };
    expect(await signerKeysRead(env, staging, { caller: 'uts-feed-staging' })).toEqual({
      status: 'answered',
      answer: {
        signers: Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => ({
          signer,
          status: 'misconfigured',
        })),
      },
    });
  });
});
