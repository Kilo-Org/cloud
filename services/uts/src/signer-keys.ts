import {
  UTS_FEED_COUNT,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type FeedKeysEntry,
  type SignerKeysAnswer,
  type SignerKeysBinding,
  type SignerKeysEntry,
  type SignerKeysRead,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { DEFAULT_DO_RETRY_CONFIG, withDORetry } from '@kilocode/worker-utils';
import { callerOf } from './callers';
import type { KeySetShardResult } from './dos/UtsKeySetDO';
import type { PublicKeysResult } from './dos/UtsSignerDO';
import { getFeedStub, getKeySetShardStub, getSignerStub, KEY_SET_SHARD_COUNT } from './dos/stubs';
import { FEED_DEPLOYMENTS, readConfig, type Env, type UtsConfig } from './env';
import type { FeedPublicKeysResult } from './feed/UtsFeedDO';

/**
 * A key-set shard answers from its copy of the last combined answer for this long after that read
 * started. Each of the 8 shards therefore reads the 16 signer objects and the 2 feed objects at
 * most once per 2 seconds, whatever the number of feed isolates (design 3).
 */
export const SIGNER_KEYS_COPY_MS = 2 * 1000;

/**
 * Every signer and feed object call of one read, retries included, ends by this deadline, so a
 * read settles within it even when an object hangs. It is shorter than the shard call deadline,
 * so the feed Worker still receives the answer built from the held keys.
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

/** Each key object's last good keys, which stand in for its failed calls for 24 hours. */
export type HeldKeys = {
  signers: ReadonlyArray<HeldSignerKeys | null>;
  feeds: ReadonlyArray<HeldSignerKeys | null>;
};

/** The settled calls of one read: the 16 signer objects and the 2 feed objects, in order. */
export type SignerAnswers = {
  signers: ReadonlyArray<PromiseSettledResult<PublicKeysResult>>;
  feeds: ReadonlyArray<PromiseSettledResult<FeedPublicKeysResult>>;
};

/** Reads the key objects; `startedAt` is the read's start, which its deadline counts from. */
export type ReadSigners = (startedAt: number) => Promise<SignerAnswers>;

/**
 * One key-set shard's state, plain data only: a request never awaits a promise another request
 * started (design 7); it polls `read` instead.
 */
export type SignerKeysCache = {
  held: HeldKeys;
  copy: { answer: SignerKeysAnswer; readAt: number } | null;
  read: { status: 'idle' } | { status: 'reading'; startedAt: number };
};

const noneHeld = (count: number) => Array.from({ length: count }, () => null);

export function newSignerKeysCache(): SignerKeysCache {
  return {
    held: { signers: noneHeld(UTS_SIGNER_COUNT), feeds: noneHeld(UTS_FEED_COUNT) },
    copy: null,
    read: { status: 'idle' },
  };
}

/** One key object's entry before it is named as a signer or a feed object. */
type ObjectEntry =
  | { status: 'ok'; keys: UtsPublicJwk[]; readAt: number }
  | { status: 'misconfigured' | 'unavailable' };

type ObjectAnswer = PromiseSettledResult<
  { status: 'ok'; keys: UtsPublicJwk[] } | { status: 'misconfigured'; reason: string }
>;

/** The entry of an object without an answer: its held keys while under 24 hours old. */
function heldEntry(
  held: HeldSignerKeys | null,
  now: number,
  failure: 'misconfigured' | 'unavailable'
): ObjectEntry {
  return held !== null && now - held.readAt < UTS_SIGNER_KEYS_HOLD_MS
    ? { status: 'ok', keys: held.keys, readAt: held.readAt }
    : { status: failure };
}

/**
 * Combines one kind's answers of the read that started at `readAt`, in object order, with the
 * keys held from earlier reads. An object that answered gives its keys at `readAt`, and they
 * become its held keys unless newer ones are held already. An object whose call failed after its
 * retries, or that refused to load, gives its held keys while they are under 24 hours old, and its
 * failure otherwise. Each failure is logged; a refused object stays refused until a deploy fixes
 * it, so it is `misconfigured`, not `unavailable`.
 */
function combineObjects(
  kind: 'signer' | 'feed',
  answers: readonly ObjectAnswer[],
  held: ReadonlyArray<HeldSignerKeys | null>,
  readAt: number,
  now: number
): { entries: ObjectEntry[]; held: Array<HeldSignerKeys | null> } {
  const nextHeld: Array<HeldSignerKeys | null> = [];
  const entries: ObjectEntry[] = [];
  for (const [index, answer] of answers.entries()) {
    const previous = held[index] ?? null;
    let failure: { status: 'misconfigured' | 'unavailable'; event: string; error: string };
    if (answer.status === 'rejected') {
      failure = {
        status: 'unavailable',
        event: `uts.signer_keys.${kind}_failed`,
        error: String(answer.reason),
      };
    } else if (answer.value.status === 'misconfigured') {
      failure = {
        status: 'misconfigured',
        event: `uts.signer_keys.${kind}_misconfigured`,
        error: answer.value.reason,
      };
    } else {
      const best =
        previous !== null && previous.readAt > readAt
          ? previous
          : { keys: answer.value.keys, readAt };
      nextHeld.push(best);
      entries.push({ status: 'ok', keys: best.keys, readAt: best.readAt });
      continue;
    }
    const entry = heldEntry(previous, now, failure.status);
    console.error(
      JSON.stringify({
        event: failure.event,
        [kind]: index,
        error: failure.error,
        heldReadAt: entry.status === 'ok' ? entry.readAt : null,
      })
    );
    nextHeld.push(previous);
    entries.push(entry);
  }
  return { entries, held: nextHeld };
}

const asSignerEntries = (entries: readonly ObjectEntry[]): SignerKeysEntry[] =>
  entries.map((entry, signer) => ({ signer, ...entry }));
const asFeedEntries = (entries: readonly ObjectEntry[]): FeedKeysEntry[] =>
  entries.map((entry, feed) => ({ feed, ...entry }));

/** Combines the answers of the read that started at `readAt` with the held keys of each object. */
export function combineSignerKeys(
  answers: SignerAnswers,
  held: HeldKeys,
  readAt: number,
  now: number
): { answer: SignerKeysAnswer; held: HeldKeys } {
  const signers = combineObjects('signer', answers.signers, held.signers, readAt, now);
  const feeds = combineObjects('feed', answers.feeds, held.feeds, readAt, now);
  return {
    answer: { signers: asSignerEntries(signers.entries), feeds: asFeedEntries(feeds.entries) },
    held: { signers: signers.held, feeds: feeds.held },
  };
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
  const fromHeld = (held: ReadonlyArray<HeldSignerKeys | null>) =>
    held.map(entry => heldEntry(entry, now, 'unavailable'));
  return {
    signers: asSignerEntries(fromHeld(cache.held.signers)),
    feeds: asFeedEntries(fromHeld(cache.held.feeds)),
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
 * Copies a key object's RPC result out and runs its disposer: workerd gives every object an RPC
 * call returns a disposer, and the call stays open until it runs. The keys are plain data, so the
 * copy stays readable. https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
async function plainResult<Result extends object>(
  call: () => Promise<Result & Partial<Disposable>>
): Promise<Result> {
  // Partial: only a workerd RPC result carries a disposer.
  const result = await call();
  try {
    // The disposer is non-enumerable, so the spread leaves it behind.
    return { ...result };
  } finally {
    result[Symbol.dispose]?.();
  }
}

/**
 * Every signer's and both feed objects' published keys, read in parallel, each call with the
 * shared Durable Object retry under the read's deadline.
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
  const [signers, feeds] = await Promise.all([
    Promise.allSettled(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) =>
        withDORetry(
          () => getSignerStub(env, config, signer),
          stub => plainResult<PublicKeysResult>(() => stub.publicKeys()),
          'uts.signer.publicKeys',
          retry
        )
      )
    ),
    Promise.allSettled(
      Array.from({ length: UTS_FEED_COUNT }, (_, feed) =>
        withDORetry(
          () => getFeedStub(env, config, feed),
          stub => plainResult<FeedPublicKeysResult>(() => stub.publicKeys()),
          'uts.feed.publicKeys',
          retry
        )
      )
    ),
  ]);
  return { signers, feeds };
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
 * `shard`. It answers only the feed Worker of the mint Worker's own environment (`callerOf`). Any
 * other caller, or a binding without props, gets `refused` without a shard call. A shard that
 * refused to load gives `misconfigured`. A shard call that fails until its deadline throws, and
 * the feed Worker counts the read as failed. The answer is plain data, so it stays readable after
 * the caller disposes the RPC result.
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
    stub => plainResult<KeySetShardResult>(() => stub.signerKeys()),
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
