/**
 * Shared request-timing primitives for the tRPC and REST surfaces.
 *
 * Pure module: no `server-only`, no database. The tRPC timing middleware and
 * the REST route wrapper both build their structured log line here, so the two
 * surfaces carry the same client dimensions and join on `requestId`.
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

/** Header names the app already sends on every request. */
export function readClientDimensions(headersList?: TimingHeaders | null): ClientDimensions {
  return {
    client: headersList?.get('x-kilo-client') ?? null,
    platform: headersList?.get('x-kilo-app-platform') ?? null,
    version: headersList?.get('x-kilo-app-version') ?? null,
    requestId: headersList?.get('x-kilo-request-id') ?? null,
  };
}

/** Mirrors the mobile test in `isMobileClient` (`lib/trpc/min-version.ts`). */
export function isMobileDimensions(client: string | null | undefined): boolean {
  return client === 'mobile';
}

/**
 * Mobile is always logged (100%); every other client is sampled at
 * `TRPC_TIMING_SAMPLE_RATE` (default `0.01`). A malformed value falls back to
 * the default. The env var is read per call so tests can set it.
 */
export function shouldLogTiming({ client }: { client: string | null | undefined }): boolean {
  if (isMobileDimensions(client)) return true;
  return Math.random() < readSampleRate();
}

function readSampleRate(): number {
  const raw = process.env.TRPC_TIMING_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SAMPLE_RATE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_SAMPLE_RATE;
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
 * `userId` is included only on a mobile line, so a sampled non-mobile line
 * never carries it.
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
  if (isMobileDimensions(dimensions.client) && userId != null) line.userId = userId;
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
 * `[...path]`/`[param]` segment onwards is dropped. A catch-all that re-exports
 * an already wrapped handler (the gateway re-exports the openrouter handler)
 * then has a pathname outside the inner pattern's prefix, so it does not emit a
 * second line.
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
