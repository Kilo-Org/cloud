import { withDORetry } from '@kilocode/worker-utils';
import { bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { ACCESS_TOKEN_ALGORITHM } from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  TOKEN_JWKS_CACHE_MS,
  TOKEN_KEY_SET_REFRESH_AHEAD_MS,
  TOKEN_KEY_SET_RETRY_MS,
  TOKEN_SIGNER_DEADLINE_MS,
  TOKEN_SIGNER_SHARDS,
} from '../constants';
import { KidSchema, readConfig, type Env, type StsConfig } from '../env';
import { callWithDeadline } from '../rpc';
import type { TokenJwk } from '../tokens/key-ring';
import { getTokenKeySetStub, getTokenSignerStub } from './stubs';
import type { TokenJwks } from './TokenSignerDO';

/** KV storage key prefix of the stored documents: one per revoked-kid list (see `documentName`). */
export const DOCUMENT_PREFIX = 'token-key-set:';

/**
 * Documents kept, one per revoked-kid list, newest first: a rollout of a new list mixes two lists
 * for a while, and each keeps its own document instead of rebuilding on every alternating read.
 */
const KEPT_LISTS = 2;

/** Exactly the public fields of one published key; a stored key with any other field fails. */
const PublicTokenJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal(ACCESS_TOKEN_ALGORITHM),
  use: z.literal('sig'),
});

const KeySetDocumentSchema = z.strictObject({
  keys: z.array(PublicTokenJwkSchema).max(TOKEN_SIGNER_SHARDS * 16),
  /** The revoked-kid list (comma-joined) the shards were read under. */
  revokedKids: z.string(),
  /** When the shard reads started, on this object's clock (ms): the document is that old. */
  builtAt: z.number().int(),
  /** A shard changed its ring after this document was built: it serves only if a rebuild fails. */
  stale: z.boolean(),
  /** A read was served since the build, so the alarm refreshes it ahead; stored so it survives. */
  read: z.boolean(),
});
type KeySetDocument = z.infer<typeof KeySetDocumentSchema>;

const RevokedKidsSchema = z.array(KidSchema);
const ShardSchema = z
  .int()
  .min(0)
  .max(TOKEN_SIGNER_SHARDS - 1);

export type TokenKeySetRead =
  /**
   * Every shard's next, current and retired-in-grace public keys, read at `builtAt` (ms). A
   * `stale` set is the best this object has (a shard changed after it answered, or a rebuild
   * failed): it is still inside its period, but no isolate may keep it.
   */
  | { status: 'ok'; keys: TokenJwk[]; builtAt: number; stale: boolean }
  /** No document fresh enough, and a shard did not answer a rebuild. */
  | { status: 'unavailable' };

/** The storage key of the document built under `revokedKids`: a list can be longer than a key. */
export async function documentName(revokedKids: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(revokedKids));
  return `${DOCUMENT_PREFIX}${bytesToBase64url(new Uint8Array(digest))}`;
}

/** When the alarm rebuilds a document reads still use, ahead of its expiry. */
function refreshAt(document: KeySetDocument): number {
  return document.builtAt + TOKEN_JWKS_CACHE_MS - TOKEN_KEY_SET_REFRESH_AHEAD_MS;
}

/**
 * The environment's service-token key set as ONE document per revoked-kid list (design 5.7), so a
 * cold STS isolate reads the set with one object call instead of one per token signer shard. It
 * holds public keys only: the shards' `getJwks` answers, copied field by field through a closed
 * schema.
 *
 * A document is built by reading every shard (each shard applies its due ring changes before it
 * answers), and serves while all of these hold:
 * - it was built under the revoked-kid list the caller passes (an emergency removal changes that
 *   list, so the first read under the new list builds its own document); the documents of the
 *   latest `KEPT_LISTS` lists are kept, so a rollout that mixes two lists rebuilds neither;
 * - it is younger than `TOKEN_JWKS_CACHE_MS`, counted from the shard reads (`builtAt`), which the
 *   isolate copy counts from too, so the two layers never add up past one period;
 * - no shard changed its ring since it answered the build: a shard calls `invalidate` after every
 *   change (publication, activation, removal, emergency removal), and its `getJwks` waits for that
 *   call before it answers; `invalidate` marks every document stale and rebuilds them in the alarm.
 *
 * A read that finds no serving document rebuilds it and waits; when the result is stale (that
 * rebuild failed and a stale document within its period is all there is, or a shard changed after
 * it answered), it answers marked `stale`, and the isolate uses it for that request only. While
 * reads arrive, the alarm rebuilds each document `TOKEN_KEY_SET_REFRESH_AHEAD_MS` before it
 * expires, so reads do not wait for the shards; an idle document is left to expire. Documents are
 * stored with their read mark, so a restarted object answers and refreshes from storage.
 * Concurrent reads of one list share one rebuild (an object's requests share its context).
 */
export class TokenKeySetDO extends DurableObject<Env> {
  readonly #config: StsConfig;
  /** The kept documents by revoked-kid list. */
  readonly #documents = new Map<string, KeySetDocument>();
  readonly #rebuilds = new Map<string, Promise<KeySetDocument | null>>();
  /**
   * `invalidate` calls per shard. A build notes each shard's count when that shard answers; a
   * count that moved by the end means the shard changed after its answer, so the build is stale.
   */
  readonly #changes: number[] = Array.from({ length: TOKEN_SIGNER_SHARDS }, () => 0);
  /** The alarm time this instance last read or set (null: none); undefined until first read. */
  #alarmAt: number | null | undefined = undefined;
  /**
   * Per list, while background rebuilds fail or come back stale, the alarm retries them until
   * this time: the expiry of the document that first needed one. Then a read rebuilds for itself.
   */
  readonly #retryUntil = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    // Addressed by a name that is not this environment's key set: every call fails.
    if (!ctx.id.equals(getTokenKeySetStub(env, config).id)) {
      throw new Error('token key set addressed by an unknown name');
    }
    this.#config = config;
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list({ prefix: DOCUMENT_PREFIX });
      for (const value of stored.values()) {
        const parsed = KeySetDocumentSchema.safeParse(value);
        if (parsed.success) this.#documents.set(parsed.data.revokedKids, parsed.data);
      }
    });
  }

  async read(revokedKidsInput: readonly string[]): Promise<TokenKeySetRead> {
    const revokedKids = RevokedKidsSchema.parse(revokedKidsInput).join(',');
    let document = this.#documents.get(revokedKids);
    if (!this.#serves(document, Date.now(), false)) {
      // A failed rebuild falls back to a stale document still inside its period.
      document = (await this.#rebuildOnce(revokedKids)) ?? this.#documents.get(revokedKids);
      if (!this.#serves(document, Date.now(), true)) return { status: 'unavailable' };
    }
    if (!document.stale) {
      if (!document.read) {
        // Stored, so an eviction before the refresh alarm does not lose it.
        document = { ...document, read: true };
        await this.#store(document);
      }
      await this.#scheduleAlarm(refreshAt(document));
    }
    return {
      status: 'ok',
      keys: document.keys.map(key => ({ ...key })),
      builtAt: document.builtAt,
      stale: document.stale,
    };
  }

  /** Shard `shard` changed its ring: every document stops serving; the alarm rebuilds them now. */
  async invalidate(shardInput: number): Promise<void> {
    const shard = ShardSchema.parse(shardInput);
    this.#changes[shard] += 1;
    let marked = false;
    for (const document of [...this.#documents.values()]) {
      if (document.stale) continue;
      await this.#store({ ...document, stale: true });
      marked = true;
    }
    if (marked) await this.#scheduleAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    // A fired alarm is no longer stored.
    this.#alarmAt = null;
    for (const document of [...this.#documents.values()]) await this.#refresh(document);
  }

  /** The alarm's work for one document: refresh ahead, rebuild a stale one, retry for a while. */
  async #refresh(document: KeySetDocument): Promise<void> {
    const now = Date.now();
    // Nothing a read may still use: the next read rebuilds.
    if (now >= document.builtAt + TOKEN_JWKS_CACHE_MS) return;
    if (!document.stale) {
      // An idle document is left to expire.
      if (!document.read) return;
      if (now < refreshAt(document)) {
        await this.#scheduleAlarm(refreshAt(document));
        return;
      }
    }
    const { revokedKids } = document;
    const rebuilt = await this.#rebuildOnce(revokedKids);
    if (rebuilt !== null && !rebuilt.stale) return;
    const until = this.#retryUntil.get(revokedKids) ?? document.builtAt + TOKEN_JWKS_CACHE_MS;
    const retryAt = Date.now() + TOKEN_KEY_SET_RETRY_MS;
    if (retryAt < until) {
      this.#retryUntil.set(revokedKids, until);
      await this.#scheduleAlarm(retryAt);
    } else {
      // Given up: a later change note starts a new run of retries; until then reads rebuild.
      this.#retryUntil.delete(revokedKids);
    }
  }

  /**
   * Whether `document` answers a read at `now`: inside its period, and not stale unless
   * `allowStale` (a failed rebuild's fallback). The caller looked it up by its list.
   */
  #serves(
    document: KeySetDocument | undefined,
    now: number,
    allowStale: boolean
  ): document is KeySetDocument {
    return (
      document !== undefined &&
      now < document.builtAt + TOKEN_JWKS_CACHE_MS &&
      (allowStale || !document.stale)
    );
  }

  /** One rebuild per list at a time; concurrent reads of that list wait for the same one. */
  async #rebuildOnce(revokedKids: string): Promise<KeySetDocument | null> {
    const pending = this.#rebuilds.get(revokedKids);
    if (pending !== undefined) return await pending;
    const promise = this.#build(revokedKids);
    this.#rebuilds.set(revokedKids, promise);
    try {
      return await promise;
    } finally {
      if (this.#rebuilds.get(revokedKids) === promise) this.#rebuilds.delete(revokedKids);
    }
  }

  /**
   * Reads every shard, in parallel and bounded like a mint, and stores the document only when all
   * of them answered. Returns null when one did not. A shard that changed after it answered makes
   * the document stale; it still answers the reads waiting on it, marked so, and the next read
   * (or the alarm that shard's `invalidate` set) rebuilds it.
   */
  async #build(revokedKids: string): Promise<KeySetDocument | null> {
    const builtAt = Date.now();
    const answers = await Promise.all(
      Array.from({ length: TOKEN_SIGNER_SHARDS }, async (_, shard) => {
        const outcome = await callWithDeadline(
          async (): Promise<TokenJwks> =>
            await withDORetry(
              () => getTokenSignerStub(this.env, this.#config, shard),
              stub => stub.getJwks(),
              'sts.tokenKeySet.getJwks'
            ),
          TOKEN_SIGNER_DEADLINE_MS
        );
        return { outcome, changes: this.#changes[shard] };
      })
    );
    const keys: TokenJwk[] = [];
    let stale = false;
    for (const [shard, { outcome, changes }] of answers.entries()) {
      if (outcome.status !== 'answered') {
        console.warn('sts: token key set could not be built', {
          outcome: outcome.status,
          reason:
            outcome.status === 'failed' && outcome.error instanceof Error
              ? outcome.error.name
              : 'none',
        });
        return null;
      }
      // Only the public fields are copied, each checked by the closed schema; a malformed key
      // fails the build like a shard that did not answer.
      for (const key of outcome.value.keys) {
        const parsed = PublicTokenJwkSchema.safeParse({
          kty: key.kty,
          crv: key.crv,
          x: key.x,
          kid: key.kid,
          alg: key.alg,
          use: key.use,
        });
        if (!parsed.success) {
          console.warn('sts: token key set could not be built', { outcome: 'malformed_key' });
          return null;
        }
        keys.push(parsed.data);
      }
      if (this.#changes[shard] !== changes) stale = true;
    }
    const document: KeySetDocument = { keys, revokedKids, builtAt, stale, read: false };
    // A concurrent build of this list may have stored a newer document meanwhile; keep that one.
    const held = this.#documents.get(revokedKids);
    if (held === undefined || held.builtAt <= builtAt) {
      if (!stale) this.#retryUntil.delete(revokedKids);
      await this.#store(document);
      await this.#keepLatestLists();
    }
    return document;
  }

  /** Stores `document`; the map keeps documents in the order they were last stored. */
  async #store(document: KeySetDocument): Promise<void> {
    this.#documents.delete(document.revokedKids);
    this.#documents.set(document.revokedKids, document);
    await this.ctx.storage.put(await documentName(document.revokedKids), document);
  }

  /** Deletes the documents of all but the `KEPT_LISTS` most recently stored lists. */
  async #keepLatestLists(): Promise<void> {
    const older = [...this.#documents.values()].slice(0, -KEPT_LISTS);
    for (const document of older) {
      this.#documents.delete(document.revokedKids);
      this.#retryUntil.delete(document.revokedKids);
      await this.ctx.storage.delete(await documentName(document.revokedKids));
    }
  }

  /** Sets the alarm for `at` unless one is due sooner; the kept time spares a storage read. */
  async #scheduleAlarm(at: number): Promise<void> {
    if (this.#alarmAt === undefined) this.#alarmAt = await this.ctx.storage.getAlarm();
    const current = this.#alarmAt;
    if (current !== null && current <= at && current >= Date.now()) return;
    await this.ctx.storage.setAlarm(at);
    this.#alarmAt = at;
  }
}
