import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types.js';

/**
 * e2e-only callback sink.
 *
 * One Durable Object instance per minted callback token records the bounded
 * callback payloads the real Worker delivers to that token's URL, so an e2e
 * scenario can assert on receipt over HTTP instead of standing up a host-local
 * server. It is bound only by the rendered e2e configs and exported only by
 * `src/e2e-entry.ts`, so the production Worker has neither the binding nor the
 * class.
 *
 * `new_sqlite_classes` is required for a new class; storage is the DO key/value
 * API, not SQL, so no drizzle migration or shared `sqlite-schema.ts` table is
 * added. Only the parsed callback body is stored: never request headers and
 * never a Kilo token.
 */

/** One hour. Expired tokens are removed by this instance's alarm. */
export const E2E_CALLBACK_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Hard per-token cap; the ingest route reports it as a non-retryable 409. */
export const E2E_CALLBACK_RECORD_LIMIT = 50;

const META_KEY = 'meta';
const RECORD_PREFIX = 'record:';

type CallbackSinkMeta = {
  ownerUserId: string;
  createdAt: number;
  expiresAt: number;
  count: number;
};

export type CallbackAppendResult = { ok: boolean; reason?: 'expired' | 'full' };
export type CallbackReadFailure = 'not_found' | 'expired' | 'forbidden';
export type CallbackReadResult = {
  ok: boolean;
  /** Raw JSON bodies, in arrival order; the route parses them for the response. */
  records: string[];
  reason?: CallbackReadFailure;
};
export type CallbackRemoveResult = { ok: boolean; reason?: CallbackReadFailure };

/** Zero-padded so `storage.list` returns records in arrival order. */
function recordKey(index: number): string {
  return `${RECORD_PREFIX}${String(index).padStart(4, '0')}`;
}

export class E2eCallbackSink extends DurableObject<Env> {
  /** Record the owning user and arm the TTL alarm. */
  async register(ownerUserId: string, ttlMs: number): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put<CallbackSinkMeta>(META_KEY, {
      ownerUserId,
      createdAt: now,
      expiresAt: now + ttlMs,
      count: 0,
    });
    await this.ctx.storage.setAlarm(now + ttlMs);
  }

  async append(rawBody: string): Promise<CallbackAppendResult> {
    return this.ctx.storage.transaction(async txn => {
      const meta = await txn.get<CallbackSinkMeta>(META_KEY);
      if (!meta || meta.expiresAt <= Date.now()) {
        return { ok: false, reason: 'expired' as const };
      }
      if (meta.count >= E2E_CALLBACK_RECORD_LIMIT) {
        return { ok: false, reason: 'full' as const };
      }
      await txn.put(recordKey(meta.count), rawBody);
      await txn.put(META_KEY, { ...meta, count: meta.count + 1 });
      return { ok: true as const };
    });
  }

  async read(ownerUserId: string): Promise<CallbackReadResult> {
    const meta = await this.ctx.storage.get<CallbackSinkMeta>(META_KEY);
    if (!meta) return { ok: false, records: [], reason: 'not_found' };
    if (meta.expiresAt <= Date.now()) return { ok: false, records: [], reason: 'expired' };
    if (meta.ownerUserId !== ownerUserId) return { ok: false, records: [], reason: 'forbidden' };
    const entries = await this.ctx.storage.list<string>({ prefix: RECORD_PREFIX });
    return { ok: true, records: [...entries.values()] };
  }

  async remove(ownerUserId: string): Promise<CallbackRemoveResult> {
    const meta = await this.ctx.storage.get<CallbackSinkMeta>(META_KEY);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (meta.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
    if (meta.ownerUserId !== ownerUserId) return { ok: false, reason: 'forbidden' };
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
