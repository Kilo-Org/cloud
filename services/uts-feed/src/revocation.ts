import {
  FeedHeadPayloadSchema,
  FeedListHashSchema,
  FeedReadsHeadSchema,
  FeedReadsListSchema,
  decodeBase64Url,
  feedListHash,
  UTS_FEED_COUNT,
  type FeedReadsBinding,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import type { z } from 'zod';
import type { FeedConfig } from './env';

/**
 * The feed Worker's side of the revocation feed (design 5.6, "Reading"): it reads a head from the
 * first feed object that answers in time and serves it from each data center's cache for 5
 * seconds; it reads a list by its hash and keeps it in that cache once the bytes match the hash.
 */

/** A feed object gets this long to answer before the next one is read. */
export const FEED_OBJECT_TIMEOUT_MS = 1000;

/** A feed object that failed is skipped for this long, unless every object failed. */
export const FEED_FAILED_OBJECT_MS = 30 * 1000;

/** How long a data center's cache keeps the head. */
export const FEED_HEAD_CACHE_SECONDS = 5;

/**
 * The oldest head this Worker serves. A head's `iat` is the start of its object's last good
 * backfill, which runs every 5 seconds and is given up after 10; the cache adds 5 seconds. A head
 * an object answers older than this counts as that object failing, so a stalled object hands over
 * to the other one, and a verifier (which refuses heads over 30 seconds old) keeps 10 seconds of
 * margin.
 */
export const FEED_HEAD_MAX_SERVED_AGE_MS = 20 * 1000;

/** A head more than this far ahead of this Worker's clock counts as a failed read (design 5.6). */
const FEED_HEAD_MAX_FUTURE_MS = 5 * 1000;

/** A list never changes under its hash, so a data center keeps it 10 minutes. */
export const FEED_LIST_CACHE_SECONDS = 10 * 60;

/** The wait a refused feed read asks for: a feed object backfills every 5 seconds. */
export const FEED_RETRY_AFTER_SECONDS = 5;

export type HeadRead =
  | { status: 'ok'; head: string; listHash: string; issuedAt: number }
  | { status: 'unavailable' }
  | { status: 'misconfigured' };

export type ListRead =
  | { status: 'ok'; bytes: Uint8Array<ArrayBuffer> }
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | { status: 'misconfigured' };

/** When each feed object last failed, per isolate and environment, as plain data. */
type FeedFailures = { environment: UtsEnvironment; failedAt: Array<number | null> };

let failures: FeedFailures | null = null;

function failuresFor(environment: UtsEnvironment): FeedFailures {
  if (failures === null || failures.environment !== environment) {
    failures = { environment, failedAt: Array.from({ length: UTS_FEED_COUNT }, () => null) };
  }
  return failures;
}

/**
 * The objects to read, in order: those that have not failed in the last 30 seconds, feed 0 first,
 * then the skipped ones, which are read only when every other one fails or holds no such list.
 */
function readOrder(state: FeedFailures, now: number): number[] {
  const all = Array.from({ length: UTS_FEED_COUNT }, (_, feed) => feed);
  const healthy = (feed: number) => {
    const failedAt = state.failedAt[feed] ?? null;
    return failedAt === null || now - failedAt >= FEED_FAILED_OBJECT_MS;
  };
  return [...all.filter(healthy), ...all.filter(feed => !healthy(feed))];
}

function disposeResult(result: unknown): void {
  if (typeof result !== 'object' || result === null || !(Symbol.dispose in result)) return;
  const dispose = result[Symbol.dispose];
  if (typeof dispose === 'function') dispose.call(result);
}

const TIMED_OUT = Symbol('timed out');

/**
 * One RPC call that has 1 second to answer, validated against `schema`. A call that throws,
 * times out or answers something else is null; a result that lands late is only disposed.
 */
async function objectCall<Schema extends z.ZodType>(
  call: () => Promise<unknown>,
  schema: Schema,
  event: string
): Promise<z.output<Schema> | null> {
  const pending = Promise.try(call);
  const timer = Promise.withResolvers<typeof TIMED_OUT>();
  const handle = setTimeout(() => timer.resolve(TIMED_OUT), FEED_OBJECT_TIMEOUT_MS);
  let result: unknown;
  try {
    result = await Promise.race([pending, timer.promise]);
  } catch (error) {
    console.error(JSON.stringify({ event: `${event}.failed`, error: String(error) }));
    return null;
  } finally {
    clearTimeout(handle);
  }
  if (result === TIMED_OUT) {
    console.error(JSON.stringify({ event: `${event}.timed_out` }));
    void pending.then(disposeResult, () => undefined);
    return null;
  }
  const parsed = schema.safeParse(result);
  disposeResult(result);
  if (!parsed.success) {
    console.error(JSON.stringify({ event: `${event}.invalid_answer` }));
    return null;
  }
  return parsed.data;
}

/** Whether a head signed at `issuedAt` (seconds) may be served at `now`. */
function servable(issuedAt: number, now: number): boolean {
  const signedAt = issuedAt * 1000;
  return now - signedAt <= FEED_HEAD_MAX_SERVED_AGE_MS && signedAt - now <= FEED_HEAD_MAX_FUTURE_MS;
}

/**
 * The `iat` and `list_hash` a head's own payload states, or null for anything that is not a
 * compact JWS with that payload. A cached head is read this way, never through fields stored
 * beside it, so an entry in the cache cannot claim a fresher time than its head carries; the
 * signature is the verifier's check.
 */
function headClaims(head: string): { issuedAt: number; listHash: string } | null {
  const parts = head.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1] ?? '')));
    const parsed = FeedHeadPayloadSchema.safeParse(payload);
    return parsed.success ? { issuedAt: parsed.data.iat, listHash: parsed.data.list_hash } : null;
  } catch {
    return null;
  }
}

/**
 * The data-center cache key of one feed path. The Cache API is one cache per zone, shared by every
 * Worker on `kiloapps.io`, so the key carries this deployment's version id, which no other Worker
 * holds: another Worker can neither read the list nor plant a head under it (design 7, as for the
 * PAT cache). A new deployment starts with an empty cache.
 */
export function feedCacheKey(config: FeedConfig, path: string): Request {
  return new Request(
    `${config.endpoints.feedOrigin}/__feed-cache/${config.environment}/${config.cacheSegment}/${path}`
  );
}

async function headFromObjects(reads: FeedReadsBinding, config: FeedConfig): Promise<HeadRead> {
  const state = failuresFor(config.environment);
  let misconfigured = 0;
  const order = readOrder(state, Date.now());
  for (const feed of order) {
    const answer = await objectCall(() => reads.head(feed), FeedReadsHeadSchema, 'uts_feed.head');
    const now = Date.now();
    if (answer?.status === 'ok' && servable(answer.issuedAt, now)) {
      state.failedAt[feed] = null;
      return answer;
    }
    if (answer?.status === 'ok') {
      console.error(
        JSON.stringify({ event: 'uts_feed.head.stale', feed, issuedAt: answer.issuedAt })
      );
    }
    if (answer?.status === 'misconfigured' || answer?.status === 'refused') {
      console.error(
        JSON.stringify({ event: 'uts_feed.head.misconfigured', feed, status: answer.status })
      );
      misconfigured += 1;
    }
    state.failedAt[feed] = now;
  }
  return misconfigured === order.length ? { status: 'misconfigured' } : { status: 'unavailable' };
}

/**
 * The current head: the data center's cached copy while it is servable, otherwise a read of the
 * feed objects, cached for 5 seconds. The cached entry is the head alone; its time and list hash
 * are read from its payload.
 */
export async function serveHead(
  reads: FeedReadsBinding,
  config: FeedConfig,
  ctx: ExecutionContext
): Promise<HeadRead> {
  const key = feedCacheKey(config, 'head');
  const cached = await caches.default.match(key);
  if (cached !== undefined) {
    const head = await cached.text();
    const claims = headClaims(head);
    if (claims !== null && servable(claims.issuedAt, Date.now())) {
      return { status: 'ok', head, ...claims };
    }
  }
  const read = await headFromObjects(reads, config);
  if (read.status === 'ok') {
    ctx.waitUntil(
      caches.default.put(
        key,
        new Response(read.head, {
          headers: { 'Cache-Control': `max-age=${FEED_HEAD_CACHE_SECONDS}` },
        })
      )
    );
  }
  return read;
}

const encoder = new TextEncoder();

/**
 * The list with hash `listHash`: the data center's cached bytes when they still match the hash,
 * otherwise a read of the feed objects, skipped ones last. An object's list is served and cached
 * only when its bytes hash to `listHash`. `not_found` only when every object answered that it holds
 * no such list.
 */
export async function serveList(
  reads: FeedReadsBinding,
  config: FeedConfig,
  listHash: unknown,
  ctx: ExecutionContext
): Promise<ListRead> {
  const hash = FeedListHashSchema.safeParse(listHash);
  if (!hash.success) return { status: 'not_found' };
  const key = feedCacheKey(config, `list/${hash.data}`);
  const cached = await caches.default.match(key);
  if (cached !== undefined) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if ((await feedListHash(bytes)) === hash.data) return { status: 'ok', bytes };
  }
  const state = failuresFor(config.environment);
  const order = readOrder(state, Date.now());
  let notFound = 0;
  let misconfigured = 0;
  for (const feed of order) {
    const answer = await objectCall(
      () => reads.list(feed, hash.data),
      FeedReadsListSchema,
      'uts_feed.list'
    );
    if (answer?.status === 'ok') {
      // The copy gives the bytes their own ArrayBuffer, the type the verifier's port takes.
      const bytes = new Uint8Array(encoder.encode(answer.list));
      if ((await feedListHash(bytes)) === hash.data) {
        ctx.waitUntil(
          caches.default.put(
            key,
            new Response(bytes, {
              headers: { 'Cache-Control': `max-age=${FEED_LIST_CACHE_SECONDS}` },
            })
          )
        );
        state.failedAt[feed] = null;
        return { status: 'ok', bytes };
      }
      console.error(JSON.stringify({ event: 'uts_feed.list.hash_mismatch', feed }));
    } else if (answer?.status === 'not_found') {
      notFound += 1;
      continue;
    } else if (answer?.status === 'misconfigured' || answer?.status === 'refused') {
      misconfigured += 1;
    }
    state.failedAt[feed] = Date.now();
  }
  if (notFound === order.length) return { status: 'not_found' };
  return misconfigured === order.length ? { status: 'misconfigured' } : { status: 'unavailable' };
}

/** Test seam: forgets which feed objects failed, as a new isolate starts. */
export function resetFeedFailures(): void {
  failures = null;
}
