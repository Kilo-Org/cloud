import { withDORetry } from '@kilocode/worker-utils';
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

/** KV storage key of the stored document. */
const DOCUMENT_NAME = 'token-key-set';

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

/**
 * The environment's service-token key set as ONE document (design 5.7), so a cold STS isolate
 * reads the set with one object call instead of one per token signer shard. It holds public keys
 * only: the shards' `getJwks` answers, copied field by field through a closed schema.
 *
 * The document is built by reading every shard (each shard applies its due ring changes before it
 * answers), and serves while all of these hold:
 * - it was built under the revoked-kid list the caller passes (an emergency removal changes that
 *   list, so the first read after the deploy rebuilds, as the isolate copy did before);
 * - it is younger than `TOKEN_JWKS_CACHE_MS`, counted from the shard reads (`builtAt`), which the
 *   isolate copy counts from too, so the two layers never add up past one period;
 * - no shard changed its ring since it answered the build: a shard calls `invalidate` after every
 *   change (publication, activation, removal, emergency removal) and before it answers any call,
 *   which marks the document stale and rebuilds it in the alarm at once.
 *
 * A read that finds no serving document rebuilds it and waits; when the result is stale (that
 * rebuild failed and a stale document within its period is all there is, or a shard changed after
 * it answered), it answers marked `stale`, and the isolate uses it for that request only. While
 * reads arrive, the alarm rebuilds the document `TOKEN_KEY_SET_REFRESH_AHEAD_MS` before it
 * expires, so reads do not wait for the shards; an idle set is left to expire. The document is
 * stored, so a restarted object answers from storage. Concurrent reads share one rebuild (an
 * object's requests share its context).
 */
export class TokenKeySetDO extends DurableObject<Env> {
  readonly #config: StsConfig;
  #document: KeySetDocument | null = null;
  #rebuild: { revokedKids: string; promise: Promise<KeySetDocument | null> } | null = null;
  /**
   * `invalidate` calls per shard. A build notes each shard's count when that shard answers; a
   * count that moved by the end means the shard changed after its answer, so the build is stale.
   */
  readonly #changes: number[] = Array.from({ length: TOKEN_SIGNER_SHARDS }, () => 0);
  /** A read was served since the document was built, so the alarm refreshes it ahead. */
  #readSinceBuild = false;
  /** The alarm time this instance last read or set (null: none); undefined until first read. */
  #alarmAt: number | null | undefined = undefined;
  /**
   * While background rebuilds fail or come back stale, the alarm retries them until this time:
   * the expiry of the document that first needed one. Then a read rebuilds for itself.
   */
  #retryUntil: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    // Addressed by a name that is not this environment's key set: every call fails.
    if (!ctx.id.equals(getTokenKeySetStub(env, config).id)) {
      throw new Error('token key set addressed by an unknown name');
    }
    this.#config = config;
    void ctx.blockConcurrencyWhile(async () => {
      const stored = KeySetDocumentSchema.safeParse(await ctx.storage.get(DOCUMENT_NAME));
      if (stored.success) this.#document = stored.data;
    });
  }

  async read(revokedKidsInput: readonly string[]): Promise<TokenKeySetRead> {
    const revokedKids = RevokedKidsSchema.parse(revokedKidsInput).join(',');
    let document = this.#document;
    if (!this.#serves(document, revokedKids, Date.now(), false)) {
      // A failed rebuild falls back to a stale document still inside its period.
      document = (await this.#rebuildOnce(revokedKids)) ?? this.#document;
      if (!this.#serves(document, revokedKids, Date.now(), true)) {
        return { status: 'unavailable' };
      }
    }
    this.#readSinceBuild = true;
    // A stale document already has its rebuild under way (a read rebuilds it, as above).
    if (!document.stale) await this.#scheduleAlarm(this.#refreshAt(document));
    return {
      status: 'ok',
      keys: document.keys.map(key => ({ ...key })),
      builtAt: document.builtAt,
      stale: document.stale,
    };
  }

  /** Shard `shard` changed its ring: the document stops serving, and the alarm rebuilds it now. */
  async invalidate(shardInput: number): Promise<void> {
    const shard = ShardSchema.parse(shardInput);
    this.#changes[shard] += 1;
    const document = this.#document;
    if (document === null || document.stale) return;
    this.#document = { ...document, stale: true };
    await this.ctx.storage.put(DOCUMENT_NAME, this.#document);
    await this.#scheduleAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    // A fired alarm is no longer stored.
    this.#alarmAt = null;
    const document = this.#document;
    const now = Date.now();
    // Nothing held, or nothing a read may still use: the next read rebuilds.
    if (document === null || now >= document.builtAt + TOKEN_JWKS_CACHE_MS) return;
    if (!document.stale) {
      // An idle set is left to expire.
      if (!this.#readSinceBuild) return;
      if (now < this.#refreshAt(document)) {
        await this.#scheduleAlarm(this.#refreshAt(document));
        return;
      }
    }
    const rebuilt = await this.#rebuildOnce(document.revokedKids);
    if (rebuilt !== null && !rebuilt.stale) return;
    this.#retryUntil ??= document.builtAt + TOKEN_JWKS_CACHE_MS;
    const retryAt = Date.now() + TOKEN_KEY_SET_RETRY_MS;
    if (retryAt < this.#retryUntil) await this.#scheduleAlarm(retryAt);
    // Given up: a later change note starts a new run of retries; until then reads rebuild.
    else this.#retryUntil = null;
  }

  /** When the alarm rebuilds a document reads still use, ahead of its expiry. */
  #refreshAt(document: KeySetDocument): number {
    return document.builtAt + TOKEN_JWKS_CACHE_MS - TOKEN_KEY_SET_REFRESH_AHEAD_MS;
  }

  /**
   * Whether `document` answers a read under `revokedKids` at `now`: built under that list, inside
   * its period, and not stale unless `allowStale` (a failed rebuild's fallback).
   */
  #serves(
    document: KeySetDocument | null,
    revokedKids: string,
    now: number,
    allowStale: boolean
  ): document is KeySetDocument {
    return (
      document !== null &&
      document.revokedKids === revokedKids &&
      now < document.builtAt + TOKEN_JWKS_CACHE_MS &&
      (allowStale || !document.stale)
    );
  }

  /** One rebuild per list at a time; concurrent reads wait for the same one. */
  async #rebuildOnce(revokedKids: string): Promise<KeySetDocument | null> {
    const pending = this.#rebuild;
    if (pending !== null && pending.revokedKids === revokedKids) return await pending.promise;
    const promise = this.#build(revokedKids);
    const entry = { revokedKids, promise };
    this.#rebuild = entry;
    try {
      return await promise;
    } finally {
      if (this.#rebuild === entry) this.#rebuild = null;
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
    const document: KeySetDocument = { keys, revokedKids, builtAt, stale };
    // A read under another list may have stored a newer document meanwhile; keep the newer one.
    const held = this.#document;
    if (held === null || held.builtAt <= builtAt) {
      this.#document = document;
      this.#readSinceBuild = false;
      if (!stale) this.#retryUntil = null;
      await this.ctx.storage.put(DOCUMENT_NAME, document);
    }
    return document;
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
