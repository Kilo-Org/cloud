import {
  tokenKid,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { KEY_SET_SHARD_COUNT } from '../../src/dos/stubs';
import type { PublicKeysResult } from '../../src/dos/UtsSignerDO';
import {
  combineSignerKeys,
  newSignerKeysCache,
  SIGNER_KEYS_COPY_MS,
  SIGNER_READ_DEADLINE_MS,
  signerKeysAnswer,
  type HeldSignerKeys,
  type ReadSigners,
  type SignerAnswers,
  type SignerKeysCache,
} from '../../src/signer-keys';

const T0 = 1_800_000_000_000;

function keysOf(signer: number, generation = 0): UtsPublicJwk[] {
  const x = `${String(generation).padStart(3, '0')}${'B'.repeat(40)}`;
  return [{ kty: 'OKP', crv: 'Ed25519', x, kid: tokenKid(signer, x), alg: 'EdDSA', use: 'sig' }];
}

function answer(signer: number, generation = 0): PromiseSettledResult<PublicKeysResult> {
  return {
    status: 'fulfilled',
    value: { status: 'ok', signer, keys: keysOf(signer, generation) },
  };
}

const all = (generation = 0) =>
  Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => answer(signer, generation));
const failed: PromiseSettledResult<PublicKeysResult> = {
  status: 'rejected',
  reason: new Error('Durable Object reset because its code was updated'),
};
const refused: PromiseSettledResult<PublicKeysResult> = {
  status: 'fulfilled',
  value: { status: 'misconfigured', reason: 'signer object was not created by its signer name' },
};
const noneHeld = (): Array<HeldSignerKeys | null> =>
  Array.from({ length: UTS_SIGNER_COUNT }, () => null);

/** A signer reader that answers `answers` and counts its reads. */
function reader(answers: () => Promise<SignerAnswers>): ReadSigners & { reads: number[] } {
  const reads: number[] = [];
  return Object.assign(
    async (startedAt: number) => {
      reads.push(startedAt);
      return await answers();
    },
    { reads }
  );
}

async function answerAt(at: number, readSigners: ReadSigners) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return await signerKeysAnswer(cache, readSigners);
  } finally {
    clock.mockRestore();
  }
}

let errors: MockInstance<typeof console.error>;
let cache: SignerKeysCache;

beforeEach(() => {
  cache = newSignerKeysCache();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('combineSignerKeys', () => {
  it('gives every signer that answered its keys at the read time, and holds them', () => {
    const { answer: combined, held } = combineSignerKeys(all(), noneHeld(), T0, T0);
    expect(combined.signers.map(entry => entry.signer)).toEqual(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => signer)
    );
    expect(combined.signers[3]).toEqual({ signer: 3, status: 'ok', keys: keysOf(3), readAt: T0 });
    expect(held[3]).toEqual({ keys: keysOf(3), readAt: T0 });
  });

  it("stands in a failed or refused signer's held keys, with the time they were read", () => {
    const { held } = combineSignerKeys(all(), noneHeld(), T0, T0);
    const answers = all(1);
    answers[4] = failed;
    answers[9] = refused;
    const later = T0 + 60_000;
    const { answer: combined, held: after } = combineSignerKeys(answers, held, later, later);
    expect(combined.signers[4]).toEqual({ signer: 4, status: 'ok', keys: keysOf(4), readAt: T0 });
    expect(combined.signers[9]).toEqual({ signer: 9, status: 'ok', keys: keysOf(9), readAt: T0 });
    expect(combined.signers[0]).toEqual({
      signer: 0,
      status: 'ok',
      keys: keysOf(0, 1),
      readAt: later,
    });
    expect(after[4]).toEqual({ keys: keysOf(4), readAt: T0 });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('"event":"uts.signer_keys.signer_failed","signer":4')
    );
  });

  it('answers the failure of a signer with no keys under 24 hours old', () => {
    const { held } = combineSignerKeys(all(), noneHeld(), T0, T0);
    const answers = all();
    answers[4] = failed;
    answers[9] = refused;
    const late = T0 + UTS_SIGNER_KEYS_HOLD_MS;
    const { answer: combined } = combineSignerKeys(answers, held, late, late);
    expect(combined.signers[4]).toEqual({ signer: 4, status: 'unavailable' });
    expect(combined.signers[9]).toEqual({ signer: 9, status: 'misconfigured' });
    const { answer: cold } = combineSignerKeys(answers, noneHeld(), T0, T0);
    expect(cold.signers[4]).toEqual({ signer: 4, status: 'unavailable' });
  });

  it('keeps newer held keys over the answer of a read that started earlier', () => {
    const { held } = combineSignerKeys(all(1), noneHeld(), T0 + 10, T0 + 10);
    const { answer: combined, held: after } = combineSignerKeys(all(0), held, T0, T0 + 20);
    expect(combined.signers[2]).toEqual({
      signer: 2,
      status: 'ok',
      keys: keysOf(2, 1),
      readAt: T0 + 10,
    });
    expect(after[2]).toEqual({ keys: keysOf(2, 1), readAt: T0 + 10 });
  });
});

describe('signerKeysAnswer', () => {
  it('answers from its copy for 2 seconds, then reads the signers again', async () => {
    const read = reader(async () => all());
    await answerAt(T0, read);
    await answerAt(T0 + SIGNER_KEYS_COPY_MS - 1, read);
    expect(read.reads).toEqual([T0]);
    await answerAt(T0 + SIGNER_KEYS_COPY_MS, read);
    expect(read.reads).toEqual([T0, T0 + SIGNER_KEYS_COPY_MS]);
  });

  it('makes one read for concurrent requests to a shard', async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const read = reader(async () => {
      await release;
      return all();
    });
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    const pending = Array.from({ length: 8 }, () => signerKeysAnswer(cache, read));
    resolve();
    const answers = await Promise.all(pending);
    expect(new Set(answers).size).toBe(1);
    expect(read.reads).toEqual([T0]);
  });

  it("stands in a failed signer's held keys on the next read", async () => {
    let answers = all();
    const read = reader(async () => answers);
    await answerAt(T0, read);
    answers = all(1);
    answers[6] = failed;
    const next = await answerAt(T0 + SIGNER_KEYS_COPY_MS, read);
    expect(next.signers[6]).toEqual({ signer: 6, status: 'ok', keys: keysOf(6), readAt: T0 });
    expect(next.signers[7]).toMatchObject({ keys: keysOf(7, 1), readAt: T0 + SIGNER_KEYS_COPY_MS });
  });

  it('answers a waiting request from the held keys when the read it waits for misses its deadline', async () => {
    let hang = false;
    const read = reader(async () =>
      hang ? await new Promise<SignerAnswers>(() => undefined) : all()
    );
    await answerAt(T0, read);
    hang = true;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0 + SIGNER_KEYS_COPY_MS);
    void signerKeysAnswer(cache, read);
    clock.mockReturnValue(T0 + SIGNER_KEYS_COPY_MS + 1);
    const waiting = signerKeysAnswer(cache, read);
    clock.mockReturnValue(T0 + SIGNER_KEYS_COPY_MS + SIGNER_READ_DEADLINE_MS);
    const answered = await waiting;
    expect(answered.signers.every(entry => entry.status === 'ok' && entry.readAt === T0)).toBe(
      true
    );
    expect(read.reads).toEqual([T0, T0 + SIGNER_KEYS_COPY_MS]);
  });

  it('keeps the newer copy and keys when an older read finishes late', async () => {
    const { promise: oldAnswer, resolve: releaseOld } = Promise.withResolvers<void>();
    let call = 0;
    const read = reader(async () => {
      call += 1;
      if (call === 1) {
        await oldAnswer;
        return all(0);
      }
      return all(1);
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    const late = signerKeysAnswer(cache, read);
    clock.mockReturnValue(T0 + SIGNER_READ_DEADLINE_MS);
    const newer = await signerKeysAnswer(cache, read);
    expect(newer.signers[0]).toMatchObject({ keys: keysOf(0, 1) });
    releaseOld();
    expect((await late).signers[0]).toMatchObject({ keys: keysOf(0, 1) });
    clock.mockReturnValue(T0 + SIGNER_READ_DEADLINE_MS + 1);
    const copy = await signerKeysAnswer(cache, read);
    expect(copy.signers[0]).toMatchObject({ keys: keysOf(0, 1) });
    expect(read.reads).toEqual([T0, T0 + SIGNER_READ_DEADLINE_MS]);
  });

  it('reads the signers at most once per shard per 2 seconds, however many isolates ask', async () => {
    const shards = Array.from({ length: KEY_SET_SHARD_COUNT }, () => ({
      cache: newSignerKeysCache(),
      read: reader(async () => all()),
    }));
    let now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // 1,000 feed isolates, each asking once per 10 seconds on the shard its isolate drew: 100
    // concurrent asks every 100 ms for 10 seconds.
    for (let step = 0; step < 100; step += 1) {
      now = T0 + step * 100;
      await Promise.all(
        Array.from({ length: 100 }, async (_, ask) => {
          const shard = shards[(step * 100 + ask) % KEY_SET_SHARD_COUNT];
          if (shard === undefined) throw new Error('no shard');
          return await signerKeysAnswer(shard.cache, shard.read);
        })
      );
    }
    for (const { read } of shards) {
      expect(read.reads).toEqual([0, 2000, 4000, 6000, 8000].map(offset => T0 + offset));
    }
  });
});
