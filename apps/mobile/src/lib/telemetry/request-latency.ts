/**
 * Per-call request-latency sampler for the mobile app.
 *
 * Pure and total: no React Native or Expo import, so the node vitest project
 * can import it — the same discipline as `network-errors.ts`. The app measures
 * `ttfbMs` (time to response headers) and `totalMs` (body read) for every tRPC
 * HTTP call, buffers the samples, and hands them to a `send` callback in
 * batches. The sample shape mirrors the `latency-ingest` worker's schema.
 *
 * The ingest endpoint is optional at the config boundary: a missing
 * `LATENCY_INGEST_URL` never fails a build — `lib/config.ts` resolves the
 * committed production default — and the sampler stays off when that resolved
 * endpoint is empty.
 */

/** Request header carrying the per-call id the server logs on its timing line. */
export const LATENCY_REQUEST_ID_HEADER = 'x-kilo-request-id';

/** Flush a batch once it holds this many samples. */
export const MAX_BATCH_SAMPLES = 50;

/** Drop the oldest samples once the serialized batch would exceed this size. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Flush a batch this long after its first pending sample. */
export const FLUSH_INTERVAL_MS = 5000;

const TRPC_PATH = '/api/trpc/';

/** One measured tRPC HTTP call. Mirrors the ingest worker's sample schema. */
export type LatencySample = {
  requestId: string;
  procedures: string[];
  ttfbMs: number;
  totalMs: number;
  status: number;
  ok: boolean;
};

/** The payload handed to `send`. */
export type LatencyBatch = {
  samples: LatencySample[];
};

/** Hands a batch to the ingest transport. Never throws into the caller. */
type LatencySend = (batch: LatencyBatch) => void | Promise<void>;

/** Schedules a flush and returns its cancel function. */
type LatencySchedule = (callback: () => void, delayMs: number) => () => void;

export type LatencyBufferOptions = {
  send: LatencySend;
  now: () => number;
  schedule: LatencySchedule;
};

export type LatencyBuffer = {
  record: (sample: LatencySample) => void;
  flush: () => void;
};

export type LatencyFetchOptions = {
  now: () => number;
  newId: () => string;
};

/**
 * Split `<procs>` from a `/api/trpc/<procs>` URL into a procedure list.
 * Returns `[]` for a URL without the tRPC path; the query string is never
 * included.
 */
export function trpcProceduresFromUrl(url: string): string[] {
  try {
    const queryIndex = url.indexOf('?');
    const pathOnly = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const index = pathOnly.indexOf(TRPC_PATH);
    if (index === -1) {
      return [];
    }
    return pathOnly
      .slice(index + TRPC_PATH.length)
      .split(',')
      .filter(procedure => procedure.length > 0);
  } catch {
    return [];
  }
}

/** UTF-8 size of the serialized batch, matching the worker's 64 KiB limit. */
function serializedBytes(samples: LatencySample[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify({ samples })).byteLength;
  } catch {
    return 0;
  }
}

/** Await an async `send` without letting its rejection reach app code. */
async function swallow(result: Promise<void>): Promise<void> {
  try {
    await result;
  } catch {
    // Async telemetry failures never reach app code.
  }
}

/**
 * Buffer latency samples and hand them to `send` in batches. A batch flushes
 * when it reaches `MAX_BATCH_SAMPLES`, when `FLUSH_INTERVAL_MS` has passed
 * since its first pending sample, or on an explicit `flush()`. The oldest
 * samples are dropped when the serialized batch would exceed
 * `MAX_PAYLOAD_BYTES`. Telemetry never throws into app code.
 */
export function createLatencyBuffer({ send, now, schedule }: LatencyBufferOptions): LatencyBuffer {
  let samples: LatencySample[] = [];
  let firstPendingAt: number | undefined = undefined;
  let cancelScheduled: (() => void) | undefined = undefined;

  function clearScheduled(): void {
    const cancel = cancelScheduled;
    cancelScheduled = undefined;
    if (cancel === undefined) {
      return;
    }
    try {
      cancel();
    } catch {
      // A hostile timer cancel must not reach app code either.
    }
  }

  function trimToPayloadCap(): void {
    while (samples.length > 0 && serializedBytes(samples) > MAX_PAYLOAD_BYTES) {
      samples.shift();
    }
    if (samples.length === 0) {
      clearScheduled();
      firstPendingAt = undefined;
    }
  }

  function flush(): void {
    clearScheduled();
    firstPendingAt = undefined;
    if (samples.length === 0) {
      return;
    }
    const batch: LatencyBatch = { samples };
    samples = [];
    try {
      const result = send(batch);
      if (result instanceof Promise) {
        void swallow(result);
      }
    } catch {
      // Telemetry must never throw into app code.
    }
  }

  function record(sample: LatencySample): void {
    const at = now();
    if (samples.length === 0) {
      firstPendingAt = at;
    }
    samples.push(sample);
    trimToPayloadCap();
    if (samples.length === 0) {
      return;
    }
    if (samples.length >= MAX_BATCH_SAMPLES) {
      flush();
      return;
    }
    if (firstPendingAt !== undefined && at - firstPendingAt >= FLUSH_INTERVAL_MS) {
      flush();
      return;
    }
    cancelScheduled ??= schedule(flush, FLUSH_INTERVAL_MS);
  }

  return { record, flush };
}

function requestUrlString(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.href;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return input;
}

/** Copy the caller's headers and set the per-call request id, replacing any
 *  stale value so exactly one id travels per call. */
function headersWithRequestId(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  requestId: string
): Headers {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(source);
  headers.set(LATENCY_REQUEST_ID_HEADER, requestId);
  return headers;
}

/** Everything a latency sample carries except the two measurements. */
type LatencyTarget = Omit<LatencySample, 'ttfbMs' | 'totalMs'>;

/**
 * Record one sample once the cloned body read settles. `createLatencyFetch`
 * deliberately does not await this promise, so the caller receives the
 * response while the body is still streaming; awaiting the clone read would
 * hold the response back for the whole download and drain the body ahead of
 * the caller. The original Response stays untouched for the caller, and a
 * failed read — including a body that can no longer be cloned — records
 * `totalMs` as `ttfbMs`.
 */
async function recordWhenBodyRead(args: {
  response: Response;
  startedAt: number;
  ttfbMs: number;
  sample: LatencyTarget;
  now: () => number;
  buffer: LatencyBuffer;
}): Promise<void> {
  const { response, startedAt, ttfbMs, sample, now, buffer } = args;
  let totalMs = ttfbMs;
  try {
    await response.clone().text();
    totalMs = now() - startedAt;
  } catch {
    totalMs = ttfbMs;
  }
  buffer.record({ ...sample, ttfbMs, totalMs });
}

/**
 * Wrap a fetch implementation so every `/api/trpc/` call records one latency
 * sample: `ttfbMs` when the response headers arrive and `totalMs` when a
 * `response.clone()` body read settles (falling back to `ttfbMs` when that
 * read fails). The original Response is returned unchanged and a rejection is
 * re-thrown unchanged with nothing recorded. The measurement is left to settle
 * on its own so it never delays the response the caller gets.
 */
export function createLatencyFetch(
  baseFetch: typeof fetch,
  buffer: LatencyBuffer,
  { now, newId }: LatencyFetchOptions
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrlString(input);
    const requestId = newId();
    const headers = headersWithRequestId(input, init, requestId);
    const startedAt = now();

    const response = await baseFetch(input, { ...init, headers });

    if (!url.includes(TRPC_PATH)) {
      return response;
    }

    const ttfbMs = now() - startedAt;
    void recordWhenBodyRead({
      response,
      startedAt,
      ttfbMs,
      sample: {
        requestId,
        procedures: trpcProceduresFromUrl(url),
        status: response.status,
        // A batched call answers 207 when it mixes results and errors, and the
        // app counts that as a failed call (`isResponseError` in `lib/trpc.ts`),
        // so a mixed batch is not `ok` even though 207 is a 2xx status.
        ok: response.status < 400 && response.status !== 207,
      },
      now,
      buffer,
    });

    return response;
  };
}
