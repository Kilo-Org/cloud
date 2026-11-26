import type { UtsPublicJwk } from '@kilocode/uts-contracts';
import type { AccessTokenKeys } from '../account/bearer';
import type { Env, UtsConfig } from '../env';
import { readKeySetShard, readThroughIsolateShard } from '../signer-keys';

/**
 * The signer keys the broker exchange verifies subject tokens with, held in isolate memory so a
 * warm exchange makes no Durable Object call for them (design 3, "Exchange a Kilo MCP access
 * token": one SQL statement and one signer call, no other Durable Object hop). The isolate reads
 * every signer's public keys from its key-set shard, the read the account API makes per request:
 * - a copy serves for 5 minutes, the verifiers' key-set lifetime (design 5.7);
 * - a `kid` the copy lacks reads again, at most once per 10 seconds, so unknown `kid`s cannot
 *   make a shard call per request;
 * - when a read fails, a copy under 1 hour old keeps serving the `kid`s it holds. A removed key
 *   also has a `kid` revocation, which the exchange statement checks, so a held copy never
 *   outlives a removal.
 */

export const KEY_COPY_LIFETIME_MS = 5 * 60 * 1000;
export const KEY_REREAD_INTERVAL_MS = 10 * 1000;
export const KEY_COPY_FAILURE_HOLD_MS = 60 * 60 * 1000;

/** Every signer's public keys, or null when the read failed. */
export type SignerKeySource = () => Promise<readonly UtsPublicJwk[] | null>;

/** The keys the isolate's key-set shard holds for every signer that answered. */
export function shardSignerKeys(env: Env, config: UtsConfig): SignerKeySource {
  return async () => {
    let read;
    try {
      read = await readThroughIsolateShard(shard => readKeySetShard(env, config, shard));
    } catch (error) {
      console.error(JSON.stringify({ event: 'uts.exchange.keys_failed', error: String(error) }));
      return null;
    }
    if (read.status !== 'answered') return null;
    return read.answer.signers.flatMap(entry => (entry.status === 'ok' ? entry.keys : []));
  };
}

/** Per isolate: the last good copy and when it was read. */
export type KeyCopy = { keys: ReadonlyMap<string, UtsPublicJwk>; readAt: number };

/**
 * Per isolate: the copy, when the last read started (null before the first one), and the read in
 * flight. The 10-second spacing counts from `attemptedAt`, so it also holds while no read has
 * succeeded yet and the shard keeps failing.
 */
export type KeyCopyState = {
  copy: KeyCopy | null;
  attemptedAt: number | null;
  reading: Promise<void> | null;
};

export function newKeyCopyState(): KeyCopyState {
  return { copy: null, attemptedAt: null, reading: null };
}

/** The `kid` lookup over the isolate's copy, refreshing it as described above. */
export function isolateSignerKeys(
  source: SignerKeySource,
  state: KeyCopyState,
  now: () => number
): AccessTokenKeys {
  const reread = async (): Promise<void> => {
    if (state.reading !== null) return await state.reading;
    const attemptedAt = now();
    state.attemptedAt = attemptedAt;
    state.reading = (async () => {
      const keys = await source();
      if (keys !== null) {
        state.copy = { keys: new Map(keys.map(key => [key.kid, key])), readAt: attemptedAt };
      }
    })();
    try {
      await state.reading;
    } finally {
      state.reading = null;
    }
  };

  return async kid => {
    const current = state.copy;
    const at = now();
    const stale = current === null || at - current.readAt >= KEY_COPY_LIFETIME_MS;
    const missing = current !== null && !current.keys.has(kid);
    const mayRead = state.attemptedAt === null || at - state.attemptedAt >= KEY_REREAD_INTERVAL_MS;
    if ((stale || missing) && mayRead) await reread();
    const copy = state.copy;
    if (copy === null) return { status: 'unavailable' };
    if (now() - copy.readAt >= KEY_COPY_FAILURE_HOLD_MS) return { status: 'unavailable' };
    const key = copy.keys.get(kid);
    return key === undefined ? { status: 'unknown' } : { status: 'found', key };
  };
}
