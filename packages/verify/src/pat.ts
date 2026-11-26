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
  type WaitUntil,
} from './flight';

/** In-instance and shared positive lifetime of a PAT lookup answer. */
export const PAT_POSITIVE_TTL_MS = 60_000;
/** In-instance and shared lifetime of a "no such PAT" answer. */
export const PAT_NEGATIVE_TTL_MS = 30_000;
/**
 * An expired positive entry serves stale this long past its expiry. One background lookup at a
 * time refreshes it; while none can run (the retry wait after a failed lookup, or the address is
 * over its limit), the entry still serves.
 */
export const PAT_MAX_STALE_MS = 10 * 60_000;
/** At most this many uncached lookups per second per client address per instance. */
export const PAT_LOOKUPS_PER_SECOND_PER_ADDRESS = 20;
/** A PAT lookup that has not answered by then counts as a failure. */
export const PAT_LOOKUP_TIMEOUT_MS = 5_000;
/** After a failed lookup, a new lookup for that hash waits this long, or longer when UTS says so. */
export const PAT_RETRY_MS = 2_000;
/** The longest retry time a UTS answer can set for one hash. */
const PAT_MAX_RETRY_MS = 60_000;
/**
 * Size bound of the instance cache (oldest entry goes first; a "no such PAT" entry can push out a
 * positive one) and of the failure and pending-lookup bookkeeping.
 */
export const MAX_INSTANCE_ENTRIES = 10_000;
/** Hard size bound of the per-address window bookkeeping; the oldest window goes first. */
export const MAX_TRACKED_ADDRESSES = 10_000;

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
 * The UTS PAT lookup by full SHA-256 hash, lowercase hex (phase 3 implements the call).
 * `not_found` covers unknown, revoked and expired PATs alike. A rejection, a `rate_limited` or
 * `unavailable` answer, or no answer within `PAT_LOOKUP_TIMEOUT_MS` is a lookup failure: the
 * request gets 503, and the hash is not looked up again before the later of `PAT_RETRY_MS` and the
 * answer's retry time.
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

/** The current key signs; the current and the previous key verify, so rotation keeps the cache. */
export type PatCacheKeys = { current: PatCacheKey; previous?: PatCacheKey };

export type PatConfig = {
  lookup: PatLookup;
  /** The workload name; part of every shared-cache key and of the authenticated text. */
  workload: string;
  sharedCache?: SharedPatCache;
  /**
   * Reads the shared-cache HMAC keys from the workload's bundle on each shared-cache read and
   * write (such as two `Secrets.get` calls), so a rotation reaches a running instance. A rejection
   * counts as a cache miss or a skipped write.
   */
  cacheKeys: (ctx: { waitUntil: WaitUntil }) => Promise<PatCacheKeys>;
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
export type SharedEntry = z.infer<typeof SharedEntrySchema>;

const EnvelopeSchema = z.strictObject({
  v: z.literal(1),
  /** Version of the key that signed `e`. */
  k: z.string().min(1),
  /** The entry as JSON text, so the MAC covers exact bytes. */
  e: z.string(),
  /** HMAC-SHA-256 over `<cache key>\n<e>`, base64. */
  m: z.string(),
});

/** One request's side of a lookup: its client address, its `waitUntil` and its calls. */
export type PatRequest = { clientAddress: string; waitUntil: WaitUntil; scope: CallScope };

export type PatResolver = {
  /**
   * Starts the shared-cache read for `hash` when the instance holds no live entry for it, so the
   * caller can run it alongside the feed read; null when there is nothing to read. Never rejects.
   */
  prefetch(hash: string, request: PatRequest): Promise<SharedEntry | null> | null;
  /** `shared`: the read `prefetch` started for this hash, used instead of a new one. */
  resolve(
    hash: string,
    request: PatRequest,
    shared: Promise<SharedEntry | null> | null
  ): Promise<PatResolution>;
  /** Drops the instance entry, for a PAT the feed revoked. */
  forget(hash: string): void;
  /** Pending lookups and tracked addresses; for tests of the size bounds. */
  sizes(): { pending: number; addresses: number };
};

export function createPatResolver(config: PatConfig): PatResolver {
  const entries = new Map<string, Entry>();
  const running = new Map<string, Attempt>();
  const failures = new Map<string, Failure>();
  const windows = new Map<string, { startedAt: number; count: number }>();
  /** Imported HMAC keys by version; a version whose secret changed is imported again. */
  const hmacKeys = new Map<string, { secret: string; key: CryptoKey }>();
  let nextAttemptId = 1;

  function sharedKey(hash: string): string {
    return `pat:${config.workload}:${hash}`;
  }

  async function hmacKey(key: PatCacheKey): Promise<CryptoKey> {
    const held = hmacKeys.get(key.version);
    if (held !== undefined && held.secret === key.secret) return held.key;
    const imported = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    hmacKeys.set(key.version, { secret: key.secret, key: imported });
    return imported;
  }

  /** The bundle's keys now; imported keys of versions it no longer lists are dropped. */
  async function currentKeys(waitUntil: WaitUntil): Promise<PatCacheKeys> {
    const keys = await config.cacheKeys({ waitUntil });
    for (const version of hmacKeys.keys()) {
      if (version !== keys.current.version && version !== keys.previous?.version) {
        hmacKeys.delete(version);
      }
    }
    return keys;
  }

  async function readShared(
    hash: string,
    now: number,
    waitUntil: WaitUntil
  ): Promise<SharedEntry | null> {
    if (config.sharedCache === undefined) return null;
    try {
      const key = sharedKey(hash);
      const text = await config.sharedCache.get(key);
      if (text === null) return null;
      const envelope = EnvelopeSchema.parse(JSON.parse(text));
      const { current, previous } = await currentKeys(waitUntil);
      const signing =
        current.version === envelope.k
          ? current
          : previous !== undefined && previous.version === envelope.k
            ? previous
            : null;
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

  async function writeShared(
    hash: string,
    entry: SharedEntry,
    ttlMs: number,
    waitUntil: WaitUntil
  ): Promise<void> {
    if (config.sharedCache === undefined) return;
    try {
      const key = sharedKey(hash);
      const e = JSON.stringify(entry);
      const signing = (await currentKeys(waitUntil)).current;
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

  /**
   * Counts one uncached lookup for `address`; false once it is over the per-second limit. Windows
   * are kept in start order, so expired ones are dropped from the front, and past the bound the
   * oldest live window goes too (that address then starts a new window).
   */
  function admit(address: string, now: number): boolean {
    const window = windows.get(address);
    if (window !== undefined && now - window.startedAt < 1000) {
      if (window.count >= PAT_LOOKUPS_PER_SECOND_PER_ADDRESS) return false;
      window.count++;
      return true;
    }
    windows.delete(address);
    for (const [tracked, w] of windows) {
      if (now - w.startedAt < 1000 && windows.size < MAX_TRACKED_ADDRESSES) break;
      windows.delete(tracked);
    }
    windows.set(address, { startedAt: now, count: 1 });
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

  /**
   * Over the bound, fails the pending lookups past their timeout. A request cancelled during its
   * lookup never settles it, and nobody may ask for that hash again; pending lookups are kept in
   * start order, so this walks only the timed-out front of the map.
   */
  function pruneRunning(at: number): void {
    if (running.size <= MAX_INSTANCE_ENTRIES) return;
    for (const [hash, pending] of running) {
      if (at < pending.startedAt + PAT_LOOKUP_TIMEOUT_MS) break;
      fail(hash, pending, pending.startedAt + PAT_LOOKUP_TIMEOUT_MS, 0);
    }
  }

  function start(hash: string, request: PatRequest, at: number): Attempt {
    const started: Attempt = { ...liveness(request.scope, at), id: nextAttemptId++ };
    running.delete(hash);
    running.set(hash, started);
    pruneRunning(at);
    startOwned(request.scope, started, PAT_LOOKUP_TIMEOUT_MS, async answered => {
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
          PAT_POSITIVE_TTL_MS,
          request.waitUntil
        );
      } else {
        const expiresAt = now + PAT_NEGATIVE_TTL_MS;
        store(hash, { kind: 'not_found', expiresAt, attemptStartedAt: started.startedAt });
        answered();
        await writeShared(
          hash,
          { kind: 'not_found', expiresAt },
          PAT_NEGATIVE_TTL_MS,
          request.waitUntil
        );
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
    request: PatRequest,
    prefetched: Promise<SharedEntry | null> | null
  ): Promise<PatResolution> {
    let sharedRead = prefetched;
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
      if (attempt !== undefined && abandoned(attempt, request.scope, now)) {
        // Its request was cancelled, so it will never answer; this request may start its own,
        // within its address's limit.
        running.delete(hash);
        awaited = null;
        continue;
      }

      if (!sharedChecked && attempt === undefined) {
        sharedChecked = true;
        const shared = await (sharedRead ?? readShared(hash, now, request.waitUntil));
        sharedRead = null;
        if (shared !== null) store(hash, { ...shared, attemptStartedAt: now });
        // Another request may have answered or started a lookup meanwhile: look again.
        continue;
      }

      const failure = failures.get(hash);
      const backingOff = failure !== undefined && now < failure.retryAt;

      // Stale-while-revalidate: an expired positive entry serves up to 10 minutes past its expiry,
      // refreshed by at most one background lookup at a time. The caller has already required a
      // feed head under 60 s.
      if (entry?.kind === 'found' && now < entry.expiresAt + PAT_MAX_STALE_MS) {
        if (attempt === undefined && !backingOff && admit(request.clientAddress, now))
          start(hash, request, now);
        return answer(entry);
      }

      if (attempt !== undefined) {
        awaited ??= attempt.id;
        await sleep(request.scope, attempt.startedAt + PAT_LOOKUP_TIMEOUT_MS);
        continue;
      }
      if (failure !== undefined && (failure.attemptId === awaited || backingOff)) {
        return {
          status: 'unavailable',
          retryAfterSeconds: retryAfterSeconds(failure.retryAt, now),
        };
      }
      if (!admit(request.clientAddress, now))
        return { status: 'rate_limited', retryAfterSeconds: 1 };
      awaited = start(hash, request, now).id;
    }
  }

  return {
    prefetch(hash, request) {
      const now = Date.now();
      const entry = entries.get(hash);
      if (config.sharedCache === undefined || (entry !== undefined && now < entry.expiresAt)) {
        return null;
      }
      return readShared(hash, now, request.waitUntil);
    },
    resolve,
    forget(hash) {
      entries.delete(hash);
    },
    sizes: () => ({ pending: running.size, addresses: windows.size }),
  };
}
