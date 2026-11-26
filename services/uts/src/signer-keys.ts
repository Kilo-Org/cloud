import {
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type SignerKeysAnswer,
  type SignerKeysBinding,
  type SignerKeysEntry,
  type SignerKeysRead,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { DEFAULT_DO_RETRY_CONFIG, withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import type { KeySetShardResult } from './dos/UtsKeySetDO';
import type { PublicKeysResult } from './dos/UtsSignerDO';
import { getKeySetShardStub, getSignerStub, KEY_SET_SHARD_COUNT } from './dos/stubs';
import { FEED_DEPLOYMENTS, readConfig, type Env, type UtsConfig } from './env';

/**
 * A key-set shard answers from its copy of the last combined answer for this long after that read
 * started. Each of the 8 shards therefore reads the 16 signer objects at most once per 2 seconds,
 * whatever the number of feed isolates (design 3).
 */
export const SIGNER_KEYS_COPY_MS = 2 * 1000;

/**
 * Every signer call of one read, retries included, ends by this deadline, so a read settles
 * within it even when an object hangs. It is shorter than the shard call deadline, so the feed
 * Worker still receives the answer built from the held keys.
 */
export const SIGNER_READ_DEADLINE_MS = 5 * 1000;

/**
 * Every call from the `SignerKeys` entrypoint to its shard, retries included, ends by this
 * deadline. A shard answers within the 5-second signer read deadline, and this is shorter than
 * the feed Worker's 10-second read guard, so a failed shard call reaches the feed Worker as a
 * failed call, not as its own timeout.
 */
export const KEY_SET_SHARD_DEADLINE_MS = 8 * 1000;

const WAIT_STEP_MS = 20;

export type HeldSignerKeys = { keys: UtsPublicJwk[]; readAt: number };

export type SignerAnswers = ReadonlyArray<PromiseSettledResult<PublicKeysResult>>;

/** Reads the 16 signer objects; `startedAt` is the read's start, which its deadline counts from. */
export type ReadSigners = (startedAt: number) => Promise<SignerAnswers>;

/**
 * One key-set shard's state, plain data only: a request never awaits a promise another request
 * started (design 7); it polls `read` instead.
 */
export type SignerKeysCache = {
  /** Each signer's last good keys, which stand in for its failed calls for 24 hours. */
  held: ReadonlyArray<HeldSignerKeys | null>;
  copy: { answer: SignerKeysAnswer; readAt: number } | null;
  read: { status: 'idle' } | { status: 'reading'; startedAt: number };
};

export function newSignerKeysCache(): SignerKeysCache {
  return {
    held: Array.from({ length: UTS_SIGNER_COUNT }, () => null),
    copy: null,
    read: { status: 'idle' },
  };
}

const CallerPropsSchema = z.strictObject({ caller: z.string().min(1) });

/** The caller a service binding's `props` name; null when the binding carries no valid props. */
function callerOf(props: unknown): string | null {
  const parsed = CallerPropsSchema.safeParse(props);
  return parsed.success ? parsed.data.caller : null;
}

/** The entry of a signer without an answer: its held keys while under 24 hours old. */
function heldEntry(
  signer: number,
  held: HeldSignerKeys | null,
  now: number,
  failure: 'misconfigured' | 'unavailable'
): SignerKeysEntry {
  return held !== null && now - held.readAt < UTS_SIGNER_KEYS_HOLD_MS
    ? { signer, status: 'ok', keys: held.keys, readAt: held.readAt }
    : { signer, status: failure };
}

/**
 * Combines the 16 answers of the read that started at `readAt`, in signer order, with the keys
 * held from earlier reads. A signer that answered gives its keys at `readAt`, and they become its
 * held keys unless newer ones are held already. A signer whose call failed after its retries, or
 * whose object refused to load, gives its held keys while they are under 24 hours old, and its
 * failure otherwise. Each failure is logged; a refused object stays refused until a deploy fixes
 * it, so it is `misconfigured`, not `unavailable`.
 */
export function combineSignerKeys(
  answers: SignerAnswers,
  held: ReadonlyArray<HeldSignerKeys | null>,
  readAt: number,
  now: number
): { answer: SignerKeysAnswer; held: Array<HeldSignerKeys | null> } {
  const nextHeld: Array<HeldSignerKeys | null> = [];
  const signers: SignerKeysEntry[] = [];
  for (const [signer, answer] of answers.entries()) {
    const previous = held[signer] ?? null;
    let failure: { status: 'misconfigured' | 'unavailable'; event: string; error: string };
    if (answer.status === 'rejected') {
      failure = {
        status: 'unavailable',
        event: 'uts.signer_keys.signer_failed',
        error: String(answer.reason),
      };
    } else if (answer.value.status === 'misconfigured') {
      failure = {
        status: 'misconfigured',
        event: 'uts.signer_keys.signer_misconfigured',
        error: answer.value.reason,
      };
    } else {
      const best =
        previous !== null && previous.readAt > readAt
          ? previous
          : { keys: answer.value.keys, readAt };
      nextHeld.push(best);
      signers.push({ signer, status: 'ok', keys: best.keys, readAt: best.readAt });
      continue;
    }
    const entry = heldEntry(signer, previous, now, failure.status);
    console.error(
      JSON.stringify({
        event: failure.event,
        signer,
        error: failure.error,
        heldReadAt: entry.status === 'ok' ? entry.readAt : null,
      })
    );
    nextHeld.push(previous);
    signers.push(entry);
  }
  return { answer: { signers }, held: nextHeld };
}

/**
 * Waits, without sharing its promise, for the read that started at `startedAt`. That read ends by
 * its deadline; a request that still finds no answer from it gets the held keys alone.
 */
async function waitForRead(cache: SignerKeysCache, startedAt: number): Promise<SignerKeysAnswer> {
  const deadline = startedAt + SIGNER_READ_DEADLINE_MS;
  while (cache.read.status === 'reading' && Date.now() < deadline) {
    await scheduler.wait(WAIT_STEP_MS);
  }
  if (cache.copy !== null && cache.copy.readAt >= startedAt) return cache.copy.answer;
  const now = Date.now();
  return {
    signers: cache.held.map((held, signer) => heldEntry(signer, held, now, 'unavailable')),
  };
}

/**
 * The answer for one request to a shard. A copy under 2 seconds old answers at once. Otherwise
 * the request waits for the read in flight, or starts the next read itself; a read that finishes
 * late never replaces a newer copy or newer held keys. A read starts only when the copy is 2
 * seconds old and no read is in flight, so `readSigners` runs at most once per 2 seconds.
 */
export async function signerKeysAnswer(
  cache: SignerKeysCache,
  readSigners: ReadSigners
): Promise<SignerKeysAnswer> {
  const now = Date.now();
  if (cache.copy !== null && now - cache.copy.readAt < SIGNER_KEYS_COPY_MS) {
    return cache.copy.answer;
  }
  if (cache.read.status === 'reading' && now - cache.read.startedAt < SIGNER_READ_DEADLINE_MS) {
    return await waitForRead(cache, cache.read.startedAt);
  }
  cache.read = { status: 'reading', startedAt: now };
  const answers = await readSigners(now);
  const combined = combineSignerKeys(answers, cache.held, now, Date.now());
  cache.held = combined.held;
  if (cache.copy === null || cache.copy.readAt < now) {
    cache.copy = { answer: combined.answer, readAt: now };
  }
  if (cache.read.status === 'reading' && cache.read.startedAt === now) {
    cache.read = { status: 'idle' };
  }
  return combined.answer;
}

/**
 * Every signer's published keys, read from the 16 signer objects in parallel. Each result is
 * copied out and its RPC disposer run: workerd gives every object an RPC call returns a disposer,
 * and the call stays open until it runs. The keys are plain data, so the copy stays readable.
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export async function readSignerObjects(
  env: Env,
  config: UtsConfig,
  startedAt: number
): Promise<SignerAnswers> {
  const retry = {
    ...DEFAULT_DO_RETRY_CONFIG,
    scope: { deadlineAt: startedAt + SIGNER_READ_DEADLINE_MS },
  };
  return await Promise.allSettled(
    Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) =>
      withDORetry(
        () => getSignerStub(env, config, signer),
        async (stub): Promise<PublicKeysResult> => {
          // Partial: only a workerd RPC result carries a disposer.
          const result: PublicKeysResult & Partial<Disposable> = await stub.publicKeys();
          try {
            // The disposer is non-enumerable, so the spread leaves it behind.
            return { ...result };
          } finally {
            result[Symbol.dispose]?.();
          }
        },
        'uts.signer.publicKeys',
        retry
      )
    )
  );
}

/**
 * The key-set shard this isolate asks, chosen at random once per isolate, so feed isolates
 * spread evenly over the 8 shards. 2^32 is a multiple of 8, so each shard gets the same share.
 * It is drawn at the first call, because a Worker cannot draw random values at startup.
 */
let isolateShard: number | null = null;

function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/**
 * One read through this isolate's shard. A read still makes exactly one shard call. When that
 * call fails, the isolate moves to a shard drawn at random from the 7 others for its later reads,
 * so a failing shard does not keep failing the same isolates and its isolates spread over the
 * rest. 2^32 is not a multiple of 7, so the draw favours some shards by less than one part in 600
 * million. Only the first failure on a shard moves the isolate: a concurrent read that failed on
 * the same shard, or one that finishes after the isolate moved, changes nothing.
 */
export async function readThroughIsolateShard(
  read: (shard: number) => Promise<SignerKeysRead>
): Promise<SignerKeysRead> {
  isolateShard ??= randomUint32() % KEY_SET_SHARD_COUNT;
  const shard = isolateShard;
  try {
    return await read(shard);
  } catch (error) {
    if (isolateShard === shard) {
      isolateShard =
        (shard + 1 + (randomUint32() % (KEY_SET_SHARD_COUNT - 1))) % KEY_SET_SHARD_COUNT;
    }
    throw error;
  }
}

/**
 * One signer-keys read for the binding whose props are `props`, answered by key-set shard
 * `shard`. It answers only the feed Worker of the mint Worker's own environment: a service binding
 * carries `props.caller`, and only a deploy in the account can set props, so the check is
 * deploy-level trust, as for the STS broker (design 6.4). Any other caller, or a binding without
 * props, gets `refused` without a shard call. A shard that refused to load gives `misconfigured`.
 * A shard call that fails until its deadline throws, and the feed Worker counts the read as
 * failed. The answer is plain data, so it stays readable after the caller disposes the RPC result.
 */
export async function signerKeysRead(
  env: Env,
  config: UtsConfig,
  props: unknown,
  shard: number
): Promise<SignerKeysRead> {
  const caller = callerOf(props);
  if (caller !== FEED_DEPLOYMENTS[config.environment]) {
    console.warn(JSON.stringify({ event: 'uts.signer_keys.refused', caller }));
    return { status: 'refused' };
  }
  const result = await withDORetry(
    () => getKeySetShardStub(env, config, shard),
    async (stub): Promise<KeySetShardResult> => {
      // Partial: only a workerd RPC result carries a disposer.
      const answered: KeySetShardResult & Partial<Disposable> = await stub.signerKeys();
      try {
        return { ...answered };
      } finally {
        answered[Symbol.dispose]?.();
      }
    },
    'uts.key_set_shard.signerKeys',
    { ...DEFAULT_DO_RETRY_CONFIG, scope: { deadlineAt: Date.now() + KEY_SET_SHARD_DEADLINE_MS } }
  );
  if (result.status === 'misconfigured') {
    console.error(
      JSON.stringify({ event: 'uts.signer_keys.shard_misconfigured', shard, error: result.reason })
    );
    return { status: 'misconfigured' };
  }
  return { status: 'answered', answer: result.answer };
}

/**
 * The named entrypoint the feed Worker binds with its deployed name as `props.caller`
 * (`UTS_SIGNER_KEYS_ENTRYPOINT`). A service binding delivers `props` to a named entrypoint, as
 * for the STS broker. Placement does not apply to a named entrypoint, so it runs where the feed
 * Worker runs, and asks its isolate's key-set shard in the EU (`readThroughIsolateShard`); the
 * default entrypoint's fetch handler, which placement covers, serves no signer keys. `test/repo`
 * keeps every other config from binding the mint Worker.
 */
export class SignerKeys extends WorkerEntrypoint<Env> implements SignerKeysBinding {
  async signerKeys(): Promise<SignerKeysRead> {
    return await readThroughIsolateShard(shard =>
      signerKeysRead(this.env, readConfig(this.env), this.ctx.props, shard)
    );
  }
}
