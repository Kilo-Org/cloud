import type { SignerKeysAnswer } from '@kilocode/uts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { readConfig, type Env, type UtsConfig } from '../env';
import {
  heldKeysToStore,
  newSignerKeysCache,
  readSignerObjects,
  signerKeysAnswer,
  StoredHeldKeysSchema,
  type SignerKeysCache,
} from '../signer-keys';
import { dataCenter } from './data-center';
import { keySetShardOfObjectId } from './stubs';

/** KV storage key of the shard's held signer keys (public keys only). */
const HELD_KEYS_KEY = 'held-keys';

/**
 * A refused shard (wrong name or jurisdiction) answers every call with `misconfigured`: a deploy
 * error that no retry fixes.
 */
export type KeySetShardResult =
  | { status: 'ok'; answer: SignerKeysAnswer }
  | { status: 'misconfigured'; reason: string };

type Phase =
  | { status: 'serving'; shard: number; cache: SignerKeysCache; logged: boolean }
  | { status: 'refused'; reason: string };

/**
 * One of the 8 key-set shards (design 5.7), named `<environment>:keyset:<0-7>`, in the `eu`
 * jurisdiction with the western-Europe hint. Each `SignerKeys` isolate asks one shard, so the 16
 * signer objects see at most 8 reads per 2 seconds, whatever the number of feed isolates
 * (design 3). The shard keeps the 2-second combined copy in memory, and each signer's held keys
 * in memory and in its storage: a restarted shard, which a deploy or an eviction causes, still
 * answers a failing signer's last good keys until 24 hours after the read they came from, so a
 * cold feed isolate never builds a key set without them. Workers RPC exposes every public method
 * of the class, so the only public member is the RPC method `signerKeys`.
 */
export class UtsKeySetDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  readonly #phase: Phase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    const id = keySetShardOfObjectId(this.#config, ctx.id);
    if (id.status === 'refused') {
      console.error(JSON.stringify({ event: 'uts.key_set_shard.refused', reason: id.reason }));
      this.#phase = id;
      return;
    }
    const cache = newSignerKeysCache();
    this.#phase = { status: 'serving', shard: id.index, cache, logged: false };
    // A load that throws (a storage failure) resets the object, and the next call loads again; the
    // catch only keeps that rejection from surfacing as unhandled.
    ctx
      .blockConcurrencyWhile(async () => {
        const stored: unknown = await ctx.storage.get(HELD_KEYS_KEY);
        if (stored === undefined) return;
        const parsed = StoredHeldKeysSchema.safeParse(stored);
        if (parsed.success) {
          cache.held = parsed.data;
        } else {
          // Only public keys a later store replaces; the shard starts without them.
          console.error(JSON.stringify({ event: 'uts.key_set_shard.stored_keys_invalid' }));
        }
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({ event: 'uts.key_set_shard.load_failed', error: String(error) })
        );
      });
  }

  /** Every signer's keys: the shard's copy while under 2 seconds old, else a new read. */
  async signerKeys(): Promise<KeySetShardResult> {
    const phase = this.#phase;
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    if (!phase.logged) {
      phase.logged = true;
      this.ctx.waitUntil(this.#logStarted(phase.shard));
    }
    const answer = await signerKeysAnswer(phase.cache, startedAt =>
      readSignerObjects(this.env, this.#config, startedAt)
    );
    await this.#storeHeld(phase.cache);
    return { status: 'ok', answer };
  }

  /**
   * Stores the held keys when a signer's kids changed or the stored copy is 10 minutes old. The
   * stored mark is set before the write, so requests that answer meanwhile do not write the same
   * keys again; a failed write puts the earlier mark back unless a newer write replaced it, and the
   * answer still goes out.
   */
  async #storeHeld(cache: SignerKeysCache): Promise<void> {
    const now = Date.now();
    const held = heldKeysToStore(cache, now);
    if (held === null) return;
    const previous = cache.stored;
    const mark = { held, at: now };
    cache.stored = mark;
    try {
      await this.ctx.storage.put(HELD_KEYS_KEY, held);
    } catch (error) {
      if (cache.stored === mark) cache.stored = previous;
      console.error(
        JSON.stringify({ event: 'uts.key_set_shard.store_failed', error: String(error) })
      );
    }
  }

  /** Records where this shard runs, once per start (design 5.7 proof run). */
  async #logStarted(shard: number): Promise<void> {
    console.log(
      JSON.stringify({
        event: 'uts.key_set_shard.started',
        shard,
        jurisdiction: this.#config.jurisdiction,
        colo: this.#config.jurisdiction === 'none' ? null : await dataCenter(),
      })
    );
  }
}
