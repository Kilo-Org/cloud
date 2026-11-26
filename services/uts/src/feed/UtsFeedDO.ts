import type { FeedPublicKeys, FeedReadsHead, FeedReadsList } from '@kilocode/uts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { withIdentityStore } from '../db/client';
import { dataCenter } from '../dos/data-center';
import { feedOfObjectId } from '../dos/stubs';
import { readConfig, type Env, type UtsConfig } from '../env';
import { identityStoreBinding } from '../grants/binding';
import { generateFeedKey, importSigningKey } from '../keys/ed25519';
import {
  advance,
  bootstrapState,
  publishedKeys,
  SignerStateSchema,
  type SignerState,
} from '../keys/lifecycle';
import { FeedEntriesSchema, type FeedEntry } from '../revocation/entries';
import { readFeedEntries, type FeedEntriesRead } from '../revocation/store';
import { FeedLedger } from './ledger';

/**
 * KV storage key of the feed key state. Its shape is the signer state's (`SignerStateSchema`),
 * with the feed index in `signer`: feed keys follow the same 30-day rotation with a published next
 * key (design 5.6, 5.7).
 */
const KEY_STATE = 'feed-key-state';

/** The alarm period: backfill, expiry and key rotation run every 5 seconds (design 5.6). */
export const FEED_ALARM_INTERVAL_MS = 5 * 1000;

/** A backfill gives up after this long, connecting included (design 3, "Revocation feed"). */
export const FEED_BACKFILL_DEADLINE_MS = 10 * 1000;
const FEED_BACKFILL_CONNECT_TIMEOUT_MS = 5 * 1000;

export type FeedPublicKeysResult =
  | ({ status: 'ok' } & FeedPublicKeys)
  | { status: 'misconfigured'; reason: string };

/**
 * `stored` names whether the object vouches for its list now, that is, whether a head it signs
 * carries the entries; `invalid_entries`: not a list of feed entries, a caller bug that no retry
 * fixes.
 */
export type FeedPublishResult =
  | { status: 'stored'; vouching: boolean }
  | { status: 'refused'; reason: 'invalid_entries' }
  | { status: 'misconfigured'; reason: string };

type Loaded = { feed: number; state: SignerState; signingKey: CryptoKey };

/** Loading runs once per start, before any call; a refused object never creates keys. */
type Phase =
  | { status: 'loading' }
  | { status: 'refused'; reason: string }
  | ({ status: 'ready' } & Loaded);

type Settled = Exclude<Phase, { status: 'loading' }>;

/**
 * One of the two revocation-feed objects (design 5.6), named `<environment>:feed:<0|1>`, in the
 * `eu` jurisdiction, feed 0 with the western-Europe hint and feed 1 with the eastern-Europe hint.
 *
 * - It holds every live feed entry in memory (`FeedLedger`) and keeps no entry in storage: the
 *   identity store is the record, and after a restart the object reads every live entry before it
 *   signs a head.
 * - Its own Ed25519 feed key, generated inside it and kept in its KV storage, signs its heads;
 *   both objects' public keys reach the UTS key set through the key-set shards.
 * - `publish` takes the entries of one revoking statement from the mint Worker, the only Worker
 *   that binds this namespace, and says whether the object vouches for its list. Every 5 seconds
 *   the alarm reads the revocations of the last 20 minutes from the identity store and adds any
 *   entry it lacks, drops expired entries at most once a minute, and rotates the feed key when due.
 * - `head` signs a head dated by the start of the last good backfill, again for each new list or
 *   backfill, and only while that backfill started under 30 seconds ago (`FeedLedger`).
 *
 * Workers RPC exposes every public method, so the only public members are the RPC methods
 * `publicKeys`, `head`, `list` and `publish` and the platform's `alarm`.
 */
export class UtsFeedDO extends DurableObject<Env> {
  readonly #config: UtsConfig;
  #phase: Phase = { status: 'loading' };
  readonly #ledger = new FeedLedger();
  #unboundLogged = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = readConfig(env);
    // A load that throws (a storage failure) resets the object, and the next call loads again; the
    // catch only keeps that rejection from surfacing as unhandled.
    ctx
      .blockConcurrencyWhile(() => this.#load())
      .catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'uts.feed.load_failed', error: String(error) }));
      });
  }

  async publicKeys(): Promise<FeedPublicKeysResult> {
    const phase = this.#settled();
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    return { status: 'ok', feed: phase.feed, keys: publishedKeys(phase.state) };
  }

  async head(): Promise<FeedReadsHead> {
    const phase = this.#settled();
    if (phase.status === 'refused') return { status: 'misconfigured' };
    const answer = await this.#ledger.head(
      { kid: phase.state.current.kid, signingKey: phase.signingKey },
      Date.now()
    );
    if (answer.status === 'refused') return { status: 'unavailable' };
    const { head } = answer;
    return { status: 'ok', head: head.compact, listHash: head.listHash, issuedAt: head.issuedAt };
  }

  async list(listHash: unknown): Promise<FeedReadsList> {
    if (this.#settled().status === 'refused') return { status: 'misconfigured' };
    const list = this.#ledger.list(listHash, Date.now());
    return list === null ? { status: 'not_found' } : { status: 'ok', list: list.text };
  }

  /** Adds the entries one revoking statement wrote; `stored` confirms the object holds them. */
  async publish(entries: unknown): Promise<FeedPublishResult> {
    const phase = this.#settled();
    if (phase.status === 'refused') return { status: 'misconfigured', reason: phase.reason };
    const parsed = FeedEntriesSchema.safeParse(entries);
    if (!parsed.success) return { status: 'refused', reason: 'invalid_entries' };
    const now = Date.now();
    this.#ledger.take(parsed.data, now);
    return { status: 'stored', vouching: this.#ledger.vouches(now) };
  }

  override async alarm(): Promise<void> {
    const phase = this.#settled();
    if (phase.status === 'refused') return;
    const now = Date.now();
    // Set first, so a failure below still leaves the next run in place.
    await this.ctx.storage.setAlarm(now + FEED_ALARM_INTERVAL_MS);
    await this.#rotateKeys(phase, now);
    await this.#backfill(now);
    this.#ledger.expire(Date.now());
  }

  #settled(): Settled {
    if (this.#phase.status === 'loading') throw new Error('feed state is not loaded');
    return this.#phase;
  }

  /**
   * One backfill, given up after `FEED_BACKFILL_DEADLINE_MS`: the alarm returns then, so the next
   * alarm runs and the ledger's stall rule applies; a read that lands later still merges.
   */
  async #backfill(now: number): Promise<void> {
    const binding = identityStoreBinding(this.env);
    if (binding.kind === 'unprovisioned') {
      if (!this.#unboundLogged) {
        this.#unboundLogged = true;
        console.warn(JSON.stringify({ event: 'uts.feed.identity_store_unbound' }));
      }
      return;
    }
    const read = this.#ledger.startBackfill(now);
    if (read === null) return;
    const run = this.#readEntries(binding.connectionString, read).then(entries =>
      this.#ledger.endBackfill(now, entries, Date.now())
    );
    this.ctx.waitUntil(run);
    const deadline = scheduler.wait(FEED_BACKFILL_DEADLINE_MS).then(() => 'timed_out' as const);
    if ((await Promise.race([run, deadline])) === 'timed_out') {
      console.error(JSON.stringify({ event: 'uts.feed.backfill_timed_out', read: read.kind }));
    }
  }

  /** The entries of one backfill read, or null when it failed or found more than the cap. */
  async #readEntries(connectionString: string, read: FeedEntriesRead): Promise<FeedEntry[] | null> {
    try {
      const result = await withIdentityStore(
        connectionString,
        this.ctx,
        store => readFeedEntries(store, read),
        { connectionTimeoutMillis: FEED_BACKFILL_CONNECT_TIMEOUT_MS }
      );
      if (result.status === 'read') return result.entries;
      console.error(JSON.stringify({ event: 'uts.feed.too_many_entries', limit: result.limit }));
    } catch (error) {
      // An `IdentityStoreError` names the SQLSTATE or system code only, never a row value.
      console.error(
        JSON.stringify({ event: 'uts.feed.backfill_failed', read: read.kind, error: String(error) })
      );
    }
    return null;
  }

  async #rotateKeys(loaded: Loaded, now: number): Promise<void> {
    const { state, events } = await advance(loaded.state, now, () => generateFeedKey(loaded.feed));
    if (state === loaded.state) return;
    await this.#commit(loaded.feed, state);
    for (const event of events) {
      console.log(JSON.stringify({ event: 'uts.feed.key_event', ...event }));
    }
  }

  async #load(): Promise<void> {
    const id = feedOfObjectId(this.#config, this.ctx.id);
    if (id.status === 'refused') {
      console.error(JSON.stringify({ event: 'uts.feed.refused', reason: id.reason }));
      this.#phase = id;
      return;
    }
    const now = Date.now();
    const stored: unknown = await this.ctx.storage.get(KEY_STATE);
    if (stored === undefined) {
      const state = await bootstrapState(id.index, now, () => generateFeedKey(id.index));
      await this.#commit(id.index, state);
      // Where the object landed, which never changes (design 5.7 proof run).
      console.log(
        JSON.stringify({
          event: 'uts.feed.bootstrapped',
          feed: id.index,
          jurisdiction: this.#config.jurisdiction,
          colo: this.#config.jurisdiction === 'none' ? null : await dataCenter(),
          kids: publishedKeys(state).map(key => key.kid),
        })
      );
    } else {
      const state = SignerStateSchema.parse(stored);
      this.#phase = {
        status: 'ready',
        feed: id.index,
        state,
        signingKey: await importSigningKey(state.current.privateJwk),
      };
    }
    // The first run starts at once, so a restarted object backfills before its first head.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now);
  }

  /** Persist first, cache second: memory never holds a key state storage does not. */
  async #commit(feed: number, state: SignerState): Promise<void> {
    const previous = this.#phase;
    const signingKey =
      previous.status === 'ready' && previous.state.current.kid === state.current.kid
        ? previous.signingKey
        : await importSigningKey(state.current.privateJwk);
    await this.ctx.storage.put(KEY_STATE, state);
    this.#phase = { status: 'ready', feed, state, signingKey };
  }
}
