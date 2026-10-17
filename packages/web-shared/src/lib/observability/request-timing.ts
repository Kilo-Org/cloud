/**
 * Shared request-timing primitives for the tRPC and REST surfaces.
 *
 * Pure module: no `server-only`, no database. The tRPC timing middleware and
 * the REST route wrapper both build their structured log line here, so the two
 * surfaces carry the same client dimensions and join on `requestId`.
 *
 * Each dimension comes from a request header, so `readClientDimensions` bounds
 * and validates every one of them before it reaches the log line: a known value
 * passes, an unrecognized non-empty value is recorded as `'other'`, and a
 * version or request id outside the accepted shape is left out. Both sample
 * rates are deployment configuration.
 */

/** Same shape the min-version helper reads (`lib/trpc/min-version.ts`). */
export type TimingHeaders = { get(name: string): string | null };

export type ClientDimensions = {
  client: string | null;
  platform: string | null;
  version: string | null;
  requestId: string | null;
};

const DEFAULT_SAMPLE_RATE = 0.01;
const DEFAULT_MOBILE_SAMPLE_RATE = 1;

/**
 * Client and platform values the first-party apps send. A non-empty value
 * outside the list is recorded as `'other'`.
 */
const KNOWN_CLIENTS = ['mobile', 'web', 'extension'] as const;
const KNOWN_PLATFORMS = ['ios', 'android'] as const;
const OTHER = 'other';

/** Same pattern the min-version helper enforces (`lib/trpc/min-version.ts`). */
const VERSION_PATTERN = /^\d+(\.\d+)*$/;
const VERSION_MAX_LENGTH = 32;

/** Accepted request-id shape: 1-64 characters from a bounded character set. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** An absent or empty header is `null`; a known value passes; anything else is `'other'`. */
function readAllowlisted(
  raw: string | null | undefined,
  allowlist: readonly string[]
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  return allowlist.includes(raw) ? raw : OTHER;
}

/** Header names the app already sends on every request. */
export function readClientDimensions(headersList?: TimingHeaders | null): ClientDimensions {
  const version = headersList?.get('x-kilo-app-version') ?? null;
  const requestId = headersList?.get('x-kilo-request-id') ?? null;
  return {
    client: readAllowlisted(headersList?.get('x-kilo-client'), KNOWN_CLIENTS),
    platform: readAllowlisted(headersList?.get('x-kilo-app-platform'), KNOWN_PLATFORMS),
    version:
      version !== null && version.length <= VERSION_MAX_LENGTH && VERSION_PATTERN.test(version)
        ? version
        : null,
    requestId: requestId !== null && REQUEST_ID_PATTERN.test(requestId) ? requestId : null,
  };
}

/** Mirrors the mobile test in `isMobileClient` (`lib/trpc/min-version.ts`). */
export function isMobileDimensions(client: string | null | undefined): boolean {
  return client === 'mobile';
}

/**
 * The mobile client is the only one with a separate rate: `TRPC_TIMING_MOBILE_SAMPLE_RATE`
 * (default `1`), while every other client is sampled at `TRPC_TIMING_SAMPLE_RATE`
 * (default `0.01`). Both rates are deployment configuration and both apply to
 * every request; `client` is the dimension returned by `readClientDimensions`.
 * A malformed value falls back to its default. The env vars are read per call so
 * tests can set them.
 */
export function shouldLogTiming({ client }: { client: string | null | undefined }): boolean {
  const mobile = isMobileDimensions(client);
  const rate = readRate(
    mobile ? process.env.TRPC_TIMING_MOBILE_SAMPLE_RATE : process.env.TRPC_TIMING_SAMPLE_RATE,
    mobile ? DEFAULT_MOBILE_SAMPLE_RATE : DEFAULT_SAMPLE_RATE
  );
  return Math.random() < rate;
}

function readRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export type TimingSurface = 'trpc' | 'rest';

export type TimingLineInput = {
  surface: TimingSurface;
  path?: string;
  route?: string;
  procedureType?: string;
  method?: string;
  durationMs: number;
  ok: boolean;
  userId?: string | null;
  dimensions: ClientDimensions;
};

export type TimingLine = {
  type: 'trpc_timing' | 'api_timing';
  surface: TimingSurface;
  durationMs: number;
  ok: boolean;
  client: string | null;
  platform: string | null;
  version: string | null;
  requestId: string | null;
  path?: string;
  route?: string;
  procedureType?: string;
  method?: string;
  userId?: string;
};

/**
 * Build the object that gets `JSON.stringify`-ed to the structured log line.
 * `userId` is included whenever the caller has an authenticated context, so the
 * emission rule never depends on a request header. The REST surface passes no
 * userId.
 */
export function buildTimingLine(input: TimingLineInput): TimingLine {
  const { surface, path, route, procedureType, method, durationMs, ok, userId, dimensions } = input;
  const line: TimingLine = {
    type: surface === 'rest' ? 'api_timing' : 'trpc_timing',
    surface,
    durationMs,
    ok,
    client: dimensions.client,
    platform: dimensions.platform,
    version: dimensions.version,
    requestId: dimensions.requestId,
  };
  if (path !== undefined) line.path = path;
  if (route !== undefined) line.route = route;
  if (procedureType !== undefined) line.procedureType = procedureType;
  if (method !== undefined) line.method = method;
  if (userId != null) line.userId = userId;
  return line;
}

export type RestRouteHandler<Ctx> = (request: Request, ctx: Ctx) => Promise<Response> | Response;

/**
 * The wrapped handler. `ctx` is optional because Next only passes a context to
 * dynamic routes, and existing callers (route tests, helpers) invoke a handler
 * with the request alone. It always returns a promise: the wrapper awaits the
 * handler, so callers can chain `.then`/`.catch` as they did before wrapping.
 */
export type TimedRestRouteHandler<Ctx> = (request: Request, ctx?: Ctx) => Promise<Response>;

/**
 * The pattern with its dynamic segments removed: everything from the first
 * `[...path]`/`[param]` segment onwards is dropped. An alias route that
 * re-exports an already wrapped handler then has a pathname outside the inner
 * pattern's prefix, so it does not emit a second line.
 */
function staticPrefix(pattern: string): string {
  const staticSegments: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment.startsWith('[') && segment.endsWith(']')) break;
    staticSegments.push(segment);
  }
  return staticSegments.join('/');
}

/**
 * Wrap a Next route handler so it emits one `api_timing` line per in-prefix
 * call, even when the handler throws (the line is emitted in `finally` and the
 * error is re-thrown). `(request, ctx)` is forwarded untouched, and neither a
 * malformed header nor a throwing `console.log` can escape into the request
 * path.
 */
export function withRestTiming<Ctx>(
  pattern: string,
  handler: RestRouteHandler<Ctx>
): TimedRestRouteHandler<Ctx> {
  const prefix = staticPrefix(pattern);
  return async (request, ctx) => {
    let pathname = '';
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = '';
    }
    if (!pathname.startsWith(prefix)) {
      return handler(request, ctx as Ctx);
    }

    const start = performance.now();
    let status = 500;
    try {
      const response = await handler(request, ctx as Ctx);
      status = response.status;
      return response;
    } finally {
      logRestTiming(pattern, request, Math.round(performance.now() - start), status);
    }
  };
}

function logRestTiming(
  pattern: string,
  request: Request,
  durationMs: number,
  status: number
): void {
  try {
    let dimensions: ClientDimensions;
    try {
      dimensions = readClientDimensions(request.headers);
    } catch {
      dimensions = { client: null, platform: null, version: null, requestId: null };
    }
    if (!shouldLogTiming({ client: dimensions.client })) return;
    console.log(
      JSON.stringify(
        buildTimingLine({
          surface: 'rest',
          route: pattern,
          method: request.method,
          durationMs,
          ok: status < 500,
          dimensions,
        })
      )
    );
  } catch {
    // Logging must never throw into the request path.
  }
}
