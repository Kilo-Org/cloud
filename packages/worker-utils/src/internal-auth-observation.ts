/**
 * Item 9 of the secrets design (section 9.4) for internal shared secrets, observe-only. Every
 * internal receiver that can admit a legacy shared secret reports what authenticated here so Axiom
 * can count, per receiver, route, caller and minute, how much still arrives through a shared secret
 * and how much already arrives through an STS token. It never changes a verdict: a refused request
 * writes nothing, and a thrown error is dropped.
 *
 * The line carries labels chosen here, never a credential: no secret, no header value as sent, no
 * request path, no address and no claim value beyond the fixed caller label. The caller label is
 * unauthenticated by construction (any holder of a shared secret can send any header), so it is
 * accepted only from a fixed list; anything else is `unknown`.
 *
 * A minute is aggregated, not a request: a bucket is (receiver, route, auth, caller) inside one
 * minute, and its first request writes one line with `count: 1` immediately. Later requests of that
 * minute only grow the bucket, and the rest of its count is written on the next observation after
 * the minute has turned, which a quiet instance may never make. The immediate line exists because
 * an isolate can shut down between requests and a lazily flushed bucket would vanish with it: a
 * legacy request that must never be lost is therefore visible the moment it happened, and only the
 * remainder of a busy minute can be lost. Lines of one bucket may appear more than once in a
 * minute; count with `sum(count)`, never `count()`.
 *
 * On unless `INTERNAL_AUTH_OBSERVATION_ENABLED` is exactly `false`, so the counter needs no
 * configuration change on any receiver. Vercel functions read it from `process.env`; Workers read
 * the same variable there, because `nodejs_compat` fills `process.env` from vars and secrets for
 * compatibility dates from 2025-04-01.
 */
export const INTERNAL_AUTH_OBSERVATION_EVENT = 'kilo_internal_auth';
/** The one way to stop the lines: exactly `false`. Everything else, including unset, keeps them. */
export const INTERNAL_AUTH_OBSERVATION_FLAG = 'INTERNAL_AUTH_OBSERVATION_ENABLED';
/**
 * A caller may name itself in this header. It is unsigned and unauthenticated: the label shows who
 * says it called, never proof, and only a name from `INTERNAL_CALLERS` is kept.
 */
export const INTERNAL_CALLER_HEADER = 'x-kilo-caller';

/** `legacy_shared_secret` compared a shared secret; `sts` verified an STS service token. */
export type InternalAuthMethod = 'legacy_shared_secret' | 'sts';

/** One aggregation bucket's worth of accepted requests, one JSON line. */
export type InternalAuthLine = {
  event: 'kilo_internal_auth';
  v: 1;
  /** The receiving surface, a fixed literal at the call site. */
  receiver: string;
  /** The route family inside that surface, a literal at the call site. */
  route: string;
  auth: InternalAuthMethod;
  /** An allowlisted `x-kilo-caller` name, or `unknown`. Never authenticated. */
  caller: string;
  /** Accepted requests in this bucket that this line accounts for. Add with `sum(count)`. */
  count: number;
  /** Bucket start, epoch seconds (a multiple of 60), not the line's own time. */
  minute: number;
};

/**
 * The callers that may appear in `caller`. Workload names from the design's internal-secret table
 * plus the in-repo callers; a name outside it is `unknown`, so the field stays low-cardinality and
 * a forged header cannot invent a label.
 */
export const INTERNAL_CALLERS: readonly string[] = [
  'ai-attribution',
  'ai-gateway',
  'ai-gateway-secure-proxy',
  'auto-routing',
  'auto-routing-benchmark',
  'bouncer',
  'bouncer-watch',
  'cloud-agent-next',
  'code-review-infra',
  'container-usage-meter',
  'event-service',
  'git-token-service',
  'kilo-chat',
  'kilo-mcp',
  'kiloclaw',
  'model-eval-ingest',
  'notifications',
  'o11y',
  'pages',
  'scim-sync',
  'security-auto-analysis',
  'security-sync',
  'session-ingest',
  'session-sync',
  'usage-ingest',
  'user-data-export',
  'uts',
  'web',
  'webhook-agent-ingest',
];

const CALLERS: ReadonlySet<string> = new Set(INTERNAL_CALLERS);

/** The allowlisted caller name in `raw`, or `unknown`. Empty and malformed values are `unknown`. */
export function callerLabel(raw: string | null | undefined): string {
  return raw !== null && raw !== undefined && CALLERS.has(raw) ? raw : 'unknown';
}

/** The test seam's global name; see `isInternalAuthObservationEnabled`. */
export const INTERNAL_AUTH_OBSERVATION_SEAM = '__KILO_INTERNAL_AUTH_OBSERVATION__';

/**
 * True unless the flag is exactly `false`. A runtime without `process.env` reads as enabled.
 *
 * `globalThis.__KILO_INTERNAL_AUTH_OBSERVATION__ = false` also disables it. That seam exists because
 * a Workers test pool keeps `process.env` as the deployment's own environment, which a test cannot
 * write; it follows the existing `__kilocodeInternalApiSecretRead` seam. Nothing in production sets
 * it.
 */
export function isInternalAuthObservationEnabled(): boolean {
  const scope: unknown = globalThis;
  if (
    typeof scope === 'object' &&
    scope !== null &&
    INTERNAL_AUTH_OBSERVATION_SEAM in scope &&
    scope[INTERNAL_AUTH_OBSERVATION_SEAM] === false
  ) {
    return false;
  }
  return !(
    typeof process !== 'undefined' && process.env?.[INTERNAL_AUTH_OBSERVATION_FLAG] === 'false'
  );
}

type Bucket = {
  minute: number;
  count: number;
  /** How much of `count` a line already carries. */
  written: number;
  receiver: string;
  route: string;
  auth: InternalAuthMethod;
  caller: string;
};

/**
 * One bucket per (receiver, route, auth, caller) of the current minute. A Worker isolate or Vercel
 * instance keeps it across requests; the cap bounds memory if a receiver ever sees unbounded
 * combinations, and flushing at the cap only splits a bucket into more lines.
 */
const MAX_BUCKETS = 512;
const buckets = new Map<string, Bucket>();
/** The largest minute observed, so a normal request does not scan the map. */
let lastMinute = 0;

/** Writes one line. Never throws: telemetry must not refuse or delay a request. */
export function writeInternalAuthLine(line: InternalAuthLine): void {
  try {
    console.log(JSON.stringify(line));
  } catch {
    // Dropped; the verdict stands.
  }
}

/** Writes part of a bucket's count and accounts for it. */
function writeBucket(bucket: Bucket, count: number): void {
  if (count <= 0) return;
  bucket.written += count;
  writeInternalAuthLine({
    event: INTERNAL_AUTH_OBSERVATION_EVENT,
    v: 1,
    receiver: bucket.receiver,
    route: bucket.route,
    auth: bucket.auth,
    caller: bucket.caller,
    count,
    minute: bucket.minute,
  });
}

/** Writes every bucket of an earlier minute and drops it: the minute has turned. */
function flushBefore(minute: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.minute >= minute) continue;
    writeBucket(bucket, bucket.count - bucket.written);
    buckets.delete(key);
  }
}

/** Opens a bucket at `minute` and writes its first request at once. */
function openBucket(
  key: string,
  minute: number,
  receiver: string,
  route: string,
  auth: InternalAuthMethod,
  caller: string
): void {
  if (buckets.size >= MAX_BUCKETS) {
    for (const bucket of buckets.values()) writeBucket(bucket, bucket.count - bucket.written);
    buckets.clear();
  }
  const bucket: Bucket = { minute, count: 1, written: 0, receiver, route, auth, caller };
  buckets.set(key, bucket);
  writeBucket(bucket, 1);
}

/**
 * Reports one accepted request. `caller` is the allowlisted `x-kilo-caller` value when the request
 * sent one, or the verified workload of an STS token; never the credential.
 *
 * Positional arguments keep the enabled path to one string key and one map update. Never throws.
 */
export function observeInternalAuth(
  receiver: string,
  route: string,
  auth: InternalAuthMethod,
  caller: string = 'unknown'
): void {
  try {
    if (!isInternalAuthObservationEnabled()) return;
    const minute = Math.floor(Date.now() / 60_000) * 60;
    const key = `${receiver}|${route}|${auth}|${caller}`;
    if (minute > lastMinute) {
      lastMinute = minute;
      flushBefore(minute);
    }
    const held = buckets.get(key);
    if (held === undefined) {
      openBucket(key, minute, receiver, route, auth, caller);
      return;
    }
    if (held.minute !== minute) {
      // Only a backwards clock reaches here: `flushBefore` keeps a later minute's bucket.
      writeBucket(held, held.count - held.written);
      buckets.delete(key);
      openBucket(key, minute, receiver, route, auth, caller);
      return;
    }
    held.count++;
  } catch {
    // Dropped; the verdict stands.
  }
}

/** Test hook: forget every bucket without writing. */
export function resetInternalAuthObservation(): void {
  buckets.clear();
  lastMinute = 0;
}
