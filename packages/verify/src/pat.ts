import { AudienceSchema, ScopeSchema } from '@kilocode/sts-contracts';
import { z } from 'zod';
import {
  abandoned,
  liveness,
  retryAfterSeconds,
  sleep,
  startOwned,
  type CallScope,
  type Liveness,
} from './flight';

/** In-instance and shared positive lifetime of a PAT lookup answer. */
export const PAT_POSITIVE_TTL_MS = 60_000;
/** In-instance and shared lifetime of a "no such PAT" answer. */
export const PAT_NEGATIVE_TTL_MS = 30_000;
/** An expired positive entry serves stale this long past its expiry while one refresh runs. */
export const PAT_MAX_STALE_MS = 10 * 60_000;
/** At most this many uncached lookups per second per client address per instance. */
export const PAT_LOOKUPS_PER_SECOND_PER_ADDRESS = 20;
/** A PAT lookup that has not answered by then counts as a failure. */
export const PAT_LOOKUP_TIMEOUT_MS = 5_000;
/** After a failed lookup, a new lookup for that hash waits this long, or longer when UTS says so. */
export const PAT_RETRY_MS = 2_000;
/** The longest retry time a UTS answer can set for one hash. */
const PAT_MAX_RETRY_MS = 60_000;
/** Instance cache size bound; the oldest entries go first. */
const MAX_INSTANCE_ENTRIES = 10_000;
/** Rate-limit window bookkeeping size bound. */
const MAX_TRACKED_ADDRESSES = 10_000;

/** What UTS holds for an active PAT: one audience and one scope. `expiresAt` is in seconds. */
export const PatRecordSchema = z.strictObject({
  patId: z.string().min(1),
  subject: z.string().min(1),
  audience: AudienceSchema,
  scope: ScopeSchema,
  org: z.string().min(1).nullable(),
  expiresAt: z.number().int().nonnegative(),
});
export type PatRecord = z.infer<typeof PatRecordSchema>;

export type PatLookupResult =
  | { status: 'found'; record: PatRecord }
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'unavailable'; retryAfterSeconds: number };

/**
 * The UTS PAT lookup by full SHA-256 hash (phase 3 implements the call). `not_found` covers
 * unknown, revoked and expired PATs alike. A rejection, a `rate_limited` or `unavailable` answer,
 * or no answer within `PAT_LOOKUP_TIMEOUT_MS` is a lookup failure: the request gets 503, and the
 * hash is not looked up again before the later of `PAT_RETRY_MS` and the answer's retry time.
 */
export type PatLookup = (hash: string, signal: AbortSignal) => Promise<PatLookupResult>;

/**
 * A shared cache in the same data center or region: the Workers Cache API or the Vercel Runtime
 * Cache. Values are opaque strings the library writes and authenticates itself; `get` returns
 * null on a miss. Errors count as a miss (get) or are ignored (put).
 */
export type SharedPatCache = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
};

/** A key from the workload's own secrets bundle; `version` names it in each entry. */
export type PatCacheKey = { version: string; secret: string };

export type PatConfig = {
  lookup: PatLookup;
  /** The workload name; part of every shared-cache key and of the authenticated text. */
  workload: string;
  sharedCache?: SharedPatCache;
  /** The current key signs; the current and the previous key verify, so rotation keeps the cache. */
  cacheKeys: { current: PatCacheKey; previous?: PatCacheKey };
};

export type PatResolution =
  | { status: 'found'; record: PatRecord }
  | { status: 'not_found' }
  /** This client address is over its uncached-lookup limit; UTS was not called. */
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'unavailable'; retryAfterSeconds: number };

type Entry =
  | { kind: 'found'; record: PatRecord; expiresAt: number; attemptStartedAt: number }
  | { kind: 'not_found'; expiresAt: number; attemptStartedAt: number };

type Attempt = Liveness & { id: number };
type Failure = { attemptId: number; retryAt: number };

const SharedEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('found'),
    record: PatRecordSchema,
    expiresAt: z.number().int(),
  }),
  z.strictObject({ kind: z.literal('not_found'), expiresAt: z.number().int() }),
]);
type SharedEntry = z.infer<typeof SharedEntrySchema>;

const EnvelopeSchema = z.strictObject({
  v: z.literal(1),
  /** Version of the key that signed `e`. */
  k: z.string().min(1),
  /** The entry as JSON text, so the MAC covers exact bytes. */
  e: z.string(),
  /** HMAC-SHA-256 over `<cache key>\n<e>`, base64. */
  m: z.string(),
});

export type PatResolver = {
  resolve(hash: string, clientAddress: string, scope: CallScope): Promise<PatResolution>;
  /** Drops the instance entry, for a PAT the feed revoked. */
  forget(hash: string): void;
};

export function createPatResolver(config: PatConfig): PatResolver {
  const entries = new Map<string, Entry>();
  const running = new Map<string, Attempt>();
  const failures = new Map<string, Failure>();
  const windows = new Map<string, { startedAt: number; count: number }>();
  const hmacKeys = new Map<string, CryptoKey>();
  let nextAttemptId = 1;

  function sharedKey(hash: string): string {
    return `pat:${config.workload}:${hash}`;
  }

  async function hmacKey(key: PatCacheKey): Promise<CryptoKey> {
    const held = hmacKeys.get(key.version);
    if (held !== undefined) return held;
    const imported = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    hmacKeys.set(key.version, imported);
    return imported;
  }

  function verifyingKey(version: string): PatCacheKey | null {
    const { current, previous } = config.cacheKeys;
    if (current.version === version) return current;
    if (previous !== undefined && previous.version === version) return previous;
    return null;
  }

  async function readShared(hash: string, now: number): Promise<SharedEntry | null> {
    if (config.sharedCache === undefined) return null;
    try {
      const key = sharedKey(hash);
      const text = await config.sharedCache.get(key);
      if (text === null) return null;
      const envelope = EnvelopeSchema.parse(JSON.parse(text));
      const signing = verifyingKey(envelope.k);
      if (signing === null) return null;
      const valid = await crypto.subtle.verify(
        'HMAC',
        await hmacKey(signing),
        Uint8Array.from(atob(envelope.m), c => c.charCodeAt(0)),
        new TextEncoder().encode(`${key}\n${envelope.e}`)
      );
      if (!valid) return null;
      const entry = SharedEntrySchema.parse(JSON.parse(envelope.e));
      const maxTtl = entry.kind === 'found' ? PAT_POSITIVE_TTL_MS : PAT_NEGATIVE_TTL_MS;
      if (entry.expiresAt <= now || entry.expiresAt > now + maxTtl) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async function writeShared(hash: string, entry: SharedEntry, ttlMs: number): Promise<void> {
    if (config.sharedCache === undefined) return;
    try {
      const key = sharedKey(hash);
      const e = JSON.stringify(entry);
      const signing = config.cacheKeys.current;
      const mac = new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          await hmacKey(signing),
          new TextEncoder().encode(`${key}\n${e}`)
        )
      );
      const envelope = { v: 1, k: signing.version, e, m: btoa(String.fromCharCode(...mac)) };
      await config.sharedCache.put(key, JSON.stringify(envelope), Math.ceil(ttlMs / 1000));
    } catch {
      // A shared-cache write is an optimisation; the instance entry already holds the answer.
    }
  }

  function store(hash: string, entry: Entry): void {
    const held = entries.get(hash);
    if (held !== undefined && held.attemptStartedAt > entry.attemptStartedAt) return;
    entries.delete(hash);
    entries.set(hash, entry);
    while (entries.size > MAX_INSTANCE_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  /** Counts one uncached lookup for `address`; false once it is over the per-second limit. */
  function admit(address: string, now: number): boolean {
    const window = windows.get(address);
    if (window === undefined || now - window.startedAt >= 1000) {
      if (windows.size >= MAX_TRACKED_ADDRESSES) {
        for (const [tracked, w] of windows) if (now - w.startedAt >= 1000) windows.delete(tracked);
      }
      windows.set(address, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= PAT_LOOKUPS_PER_SECOND_PER_ADDRESS) return false;
    window.count++;
    return true;
  }

  function fail(hash: string, done: Attempt, at: number, hintSeconds: number): void {
    if (running.get(hash)?.id !== done.id) return;
    running.delete(hash);
    const hintMs = Number.isFinite(hintSeconds)
      ? Math.min(hintSeconds * 1000, PAT_MAX_RETRY_MS)
      : 0;
    failures.set(hash, { attemptId: done.id, retryAt: at + Math.max(PAT_RETRY_MS, hintMs) });
    if (failures.size > MAX_INSTANCE_ENTRIES) {
      for (const [key, f] of failures) if (f.retryAt <= at) failures.delete(key);
    }
  }

  function start(hash: string, scope: CallScope, at: number): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextAttemptId++ };
    running.set(hash, started);
    startOwned(scope, started, PAT_LOOKUP_TIMEOUT_MS, async answered => {
      let result: PatLookupResult;
      try {
        result = await config.lookup(hash, AbortSignal.timeout(PAT_LOOKUP_TIMEOUT_MS));
        if (result.status === 'found') {
          result = { status: 'found', record: PatRecordSchema.parse(result.record) };
        }
      } catch {
        result = { status: 'unavailable', retryAfterSeconds: 0 };
      }
      const now = Date.now();
      if (result.status === 'rate_limited' || result.status === 'unavailable') {
        fail(hash, started, now, result.retryAfterSeconds);
        answered();
        return;
      }
      if (running.get(hash)?.id === started.id) running.delete(hash);
      failures.delete(hash);
      if (result.status === 'found') {
        const expiresAt = now + PAT_POSITIVE_TTL_MS;
        store(hash, {
          kind: 'found',
          record: result.record,
          expiresAt,
          attemptStartedAt: started.startedAt,
        });
        answered();
        await writeShared(
          hash,
          { kind: 'found', record: result.record, expiresAt },
          PAT_POSITIVE_TTL_MS
        );
      } else {
        const expiresAt = now + PAT_NEGATIVE_TTL_MS;
        store(hash, { kind: 'not_found', expiresAt, attemptStartedAt: started.startedAt });
        answered();
        await writeShared(hash, { kind: 'not_found', expiresAt }, PAT_NEGATIVE_TTL_MS);
      }
    });
    return started;
  }

  function answer(entry: Entry): PatResolution {
    return entry.kind === 'found'
      ? { status: 'found', record: entry.record }
      : { status: 'not_found' };
  }

  async function resolve(
    hash: string,
    clientAddress: string,
    scope: CallScope
  ): Promise<PatResolution> {
    let sharedChecked = false;
    let awaited: number | null = null;
    for (;;) {
      const now = Date.now();
      const entry = entries.get(hash);
      if (entry !== undefined && now < entry.expiresAt) return answer(entry);

      const attempt = running.get(hash);
      if (attempt !== undefined && now >= attempt.startedAt + PAT_LOOKUP_TIMEOUT_MS) {
        fail(hash, attempt, attempt.startedAt + PAT_LOOKUP_TIMEOUT_MS, 0);
        continue;
      }
      if (attempt !== undefined && abandoned(attempt, scope, now)) {
        // Its request was cancelled, so it will never answer; this request may start its own.
        running.delete(hash);
        awaited = null;
        continue;
      }

      if (!sharedChecked && attempt === undefined) {
        sharedChecked = true;
        const shared = await readShared(hash, now);
        if (shared !== null) store(hash, { ...shared, attemptStartedAt: now });
        // Another request may have answered or started a lookup meanwhile: look again.
        continue;
      }

      const failure = failures.get(hash);
      const backingOff = failure !== undefined && now < failure.retryAt;

      // Stale-while-revalidate: an expired positive entry serves up to 10 minutes past its expiry
      // while one background lookup runs. The caller has already required a feed head under 60 s.
      if (entry?.kind === 'found' && now < entry.expiresAt + PAT_MAX_STALE_MS) {
        if (attempt === undefined && !backingOff && admit(clientAddress, now))
          start(hash, scope, now);
        return answer(entry);
      }

      if (attempt !== undefined) {
        awaited ??= attempt.id;
        await sleep(scope, attempt.startedAt + PAT_LOOKUP_TIMEOUT_MS);
        continue;
      }
      if (failure !== undefined && (failure.attemptId === awaited || backingOff)) {
        return {
          status: 'unavailable',
          retryAfterSeconds: retryAfterSeconds(failure.retryAt, now),
        };
      }
      if (!admit(clientAddress, now)) return { status: 'rate_limited', retryAfterSeconds: 1 };
      awaited = start(hash, scope, now).id;
    }
  }

  return {
    resolve,
    forget(hash) {
      entries.delete(hash);
    },
  };
}
