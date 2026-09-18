/**
 * Warning-level network-error reporting for the mobile app.
 *
 * Pure and total: no SDK import, no network, no React. The caller installs a
 * transport sink (s2 wires the Sentry adapter); until then every report is a
 * no-op. Query strings are never emitted — tRPC input and tokens live there
 * (mirrors `sentry-scrub.ts`).
 */

import { z } from 'zod';

import { captureTelemetry } from '@/lib/telemetry/error-sink';

type TelemetrySource = 'trpc' | 'fetch';

type NetworkOutcome = 'timeout' | 'http_error' | 'failed';

export type TrpcErrorContext = {
  code?: string;
  httpStatus?: number;
  path?: string;
  message?: string;
};

export type NetworkErrorContext = {
  source: TelemetrySource;
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  durationMs: number;
  error?: unknown;
  timedOut?: boolean;
};

export type NetworkErrorFetchOptions = {
  source?: TelemetrySource;
  shouldReport?: (url: string) => boolean;
  isResponseError?: (status: number) => boolean;
  readResponseError?: (
    response: Response
  ) => Promise<TrpcResponseError | undefined> | TrpcResponseError | undefined;
};

// tRPC server error shape (packages @trpc/server `getErrorShape`) exposes
// `data.httpStatus` / `data.path`; v11 client errors expose flat `data.*`.
const TrpcErrorDataSchema = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
  httpStatus: z.number().optional(),
  path: z.string().optional(),
});

const DirectTrpcErrorSchema = z.looseObject({
  data: TrpcErrorDataSchema.optional(),
});

const ShapedTrpcErrorSchema = z.looseObject({
  shape: z.looseObject({ data: TrpcErrorDataSchema.optional() }),
});

const TopLevelCodeSchema = z.looseObject({ code: z.string() });

// The `error` of a tRPC failure body (batch item or direct body) is a plain
// object; anything else yields no context.
const TrpcResponseErrorSchema = z.record(z.string(), z.unknown());

const ResponseErrorItemSchema = z.looseObject({ error: TrpcResponseErrorSchema });

/** A parsed tRPC error object read from a response body. */
export type TrpcResponseError = z.infer<typeof TrpcResponseErrorSchema>;

// `Error`, `DOMException` and Expo's error-like objects carry `name`/`message`;
// abort and deadline checks key on those fields (and a wrapper's `cause`) so a
// structured error never needs an `instanceof` across bundles.
const NamedErrorSchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  cause: z.unknown().optional(),
});

const TRPC_PATH = '/api/trpc/';
const HTTP_URL_PATTERN = /^https?:\/\//iu;

/** Strip the query string from a URL. Returns empty string on a non-string. */
export function stripQueryString(url: string): string {
  try {
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  } catch {
    return '';
  }
}

/** Extract `<procs>` from a `/api/trpc/<procs>` URL, query string removed. */
export function trpcProcedureFromUrl(url: string): string | undefined {
  try {
    const pathOnly = stripQueryString(url);
    const index = pathOnly.indexOf(TRPC_PATH);
    if (index === -1) {
      return undefined;
    }
    const procedure = pathOnly.slice(index + TRPC_PATH.length);
    return procedure.length > 0 ? procedure : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read tRPC error metadata from a direct (`data.*`) or server-shaped
 * (`shape.data.*`) error. Total: an unrecognized value yields `{}`.
 */
export function readTrpcErrorContext(error: unknown): TrpcErrorContext {
  try {
    const direct = DirectTrpcErrorSchema.safeParse(error);
    const shaped = ShapedTrpcErrorSchema.safeParse(error);
    const directData = direct.success ? direct.data.data : undefined;
    const shapedData = shaped.success ? shaped.data.shape.data : undefined;
    const topLevelCode = TopLevelCodeSchema.safeParse(error);
    return {
      code:
        directData?.code ??
        shapedData?.code ??
        (topLevelCode.success ? topLevelCode.data.code : undefined),
      httpStatus: directData?.httpStatus ?? shapedData?.httpStatus,
      path: directData?.path ?? shapedData?.path,
      message:
        directData?.message ??
        shapedData?.message ??
        (error instanceof Error ? error.message : undefined),
    };
  } catch {
    return {};
  }
}

/**
 * Read the tRPC error out of a batch response body without consuming the
 * original: the clone is parsed, so the caller still owns `response`. A
 * batched (HTTP 207) body is an array of `{ result } | { error }`; a plain
 * failure body is `{ error }`. Total: a success-only, non-JSON, or otherwise
 * unreadable body yields `undefined` and never throws.
 */
export async function readTrpcResponseError(
  response: Response
): Promise<TrpcResponseError | undefined> {
  try {
    const body: unknown = await response.clone().json();
    if (Array.isArray(body)) {
      for (const item of body) {
        const error = errorPropertyOf(item);
        if (error !== undefined) {
          return error;
        }
      }
      return undefined;
    }
    return errorPropertyOf(body);
  } catch {
    return undefined;
  }
}

function errorPropertyOf(value: unknown): TrpcResponseError | undefined {
  const parsed = ResponseErrorItemSchema.safeParse(value);
  return parsed.success ? parsed.data.error : undefined;
}

// Abort/cancellation surfaces Expo and iOS produce. `AbortError` covers the
// web/RN DOMException; the rest are the names Expo's fetch and native modules
// reject with (e.g. `fetch failed: FetchRequestCanceledException: Fetch
// request has been canceled`).
const ABORT_ERROR_NAMES = new Set([
  'AbortError',
  'CanceledError',
  'CancellationException',
  'FetchRequestCanceledException',
  'AbortException',
]);

const ABORT_ERROR_MESSAGES = ['Fetch request has been canceled', 'The operation was aborted'];

// A wrapper may carry the cancellation in `cause`; bound the walk so a
// self-referential chain can never loop.
const MAX_CAUSE_DEPTH = 5;

/** True for an abort/cancellation, by name, Expo/iOS message, or `cause`. */
export function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    try {
      const parsed = NamedErrorSchema.safeParse(current);
      if (!parsed.success) {
        return false;
      }
      const { name, message, cause } = parsed.data;
      if (name !== undefined && ABORT_ERROR_NAMES.has(name)) {
        return true;
      }
      if (message !== undefined && ABORT_ERROR_MESSAGES.some(token => message.includes(token))) {
        return true;
      }
      current = cause;
    } catch {
      return false;
    }
  }
  return false;
}

function isRequestDeadlineError(error: unknown): boolean {
  try {
    const parsed = NamedErrorSchema.safeParse(error);
    return parsed.success && parsed.data.name === 'RequestDeadlineError';
  } catch {
    return false;
  }
}

function statusClassFor(status: number | undefined): '4xx' | '5xx' | undefined {
  if (status === undefined || status < 400) {
    return undefined;
  }
  return status < 500 ? '4xx' : '5xx';
}

function networkOutcome(context: NetworkErrorContext): NetworkOutcome {
  if (context.timedOut === true) {
    return 'timeout';
  }
  if (context.status !== undefined && (context.status >= 400 || context.status === 207)) {
    return 'http_error';
  }
  return 'failed';
}

function buildSyntheticError(context: NetworkErrorContext, pathOnly: string): Error {
  const method = context.method ?? 'GET';
  if (context.status !== undefined) {
    return new Error(`${method} ${pathOnly} -> ${context.status}`);
  }
  return new Error(`${method} ${pathOnly} failed after ${context.durationMs}ms`);
}

/** True when the raw error is a body worth preserving alongside the report. */
function hasErrorBody(value: unknown): boolean {
  return value !== undefined && value !== null && !(value instanceof Error);
}

/**
 * Build and emit one warning-level telemetry event for a network error.
 * Never throws; never includes headers, bodies, or query strings.
 */
export function reportNetworkError(context: NetworkErrorContext): void {
  try {
    const pathOnly = stripQueryString(context.url);
    const procedure = trpcProcedureFromUrl(context.url);
    const trpcCode = readTrpcErrorContext(context.error).code;
    const statusClass = statusClassFor(context.status);
    const outcome = networkOutcome(context);
    // Sentry needs an Error for a usable title and stack: a tRPC failure body
    // is a plain object, so synthesize one naming the procedure and status.
    const rawError = context.error;
    const error = rawError instanceof Error ? rawError : buildSyntheticError(context, pathOnly);

    const tags = {
      'error.subsystem': 'network',
      'error.source': context.source,
      'network.outcome': outcome,
      ...(context.method === undefined ? {} : { 'http.method': context.method }),
      ...(context.status === undefined ? {} : { 'http.status': context.status }),
      ...(statusClass === undefined ? {} : { 'http.status_class': statusClass }),
      ...(procedure === undefined ? {} : { 'trpc.procedure': procedure }),
      ...(trpcCode === undefined ? {} : { 'trpc.code': trpcCode }),
    };

    const network = {
      url: pathOnly,
      durationMs: context.durationMs,
      outcome,
      ...(context.method === undefined ? {} : { method: context.method }),
      ...(context.status === undefined ? {} : { status: context.status }),
      ...(context.statusText === undefined ? {} : { statusText: context.statusText }),
      ...(procedure === undefined ? {} : { procedure }),
      ...(trpcCode === undefined ? {} : { trpcCode }),
      ...(context.timedOut === undefined ? {} : { timedOut: context.timedOut }),
      // Keep the raw body (`{code, data, message}`) that the tags and title
      // derive from, without letting it become the exception's title.
      ...(hasErrorBody(rawError) ? { errorBody: rawError } : {}),
    };

    captureTelemetry({
      level: 'warning',
      error,
      tags,
      contexts: { network },
      fingerprint: ['network-error', context.source, procedure ?? pathOnly, statusClass ?? outcome],
    });
  } catch {
    // Telemetry must never throw into app code.
  }
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

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  if (init?.method !== undefined) {
    return init.method;
  }
  if (input instanceof Request) {
    return input.method;
  }
  return undefined;
}

function isHttpUrl(url: string): boolean {
  return HTTP_URL_PATTERN.test(url);
}

function safeShouldReport(url: string, shouldReport: (url: string) => boolean): boolean {
  try {
    return isHttpUrl(url) && shouldReport(url);
  } catch {
    return false;
  }
}

/**
 * Wrap a fetch implementation so every failed (or error-status) http(s)
 * request is reported once at warning level. `isResponseError` chooses the
 * statuses that count as errors (default `>= 400`; tRPC adds 207 so a mixed
 * batch is reported). `readResponseError` may parse the body via a clone to
 * enrich the report. The original rejection is re-thrown and the original
 * Response is returned unchanged; the original body is never read.
 */
export function createNetworkErrorFetch(
  baseFetch: typeof fetch,
  options?: NetworkErrorFetchOptions
): typeof fetch {
  const source = options?.source ?? 'fetch';
  const shouldReport = options?.shouldReport ?? (() => true);
  const isResponseError = options?.isResponseError ?? (status => status >= 400);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrlString(input);
    const method = requestMethod(input, init);
    const startedAt = Date.now();
    try {
      const response = await baseFetch(input, init);
      if (isResponseError(response.status) && safeShouldReport(url, shouldReport)) {
        let error: TrpcResponseError | undefined = undefined;
        if (options?.readResponseError) {
          try {
            error = await options.readResponseError(response);
          } catch {
            error = undefined;
          }
        }
        reportNetworkError({
          source,
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - startedAt,
          ...(error === undefined ? {} : { error }),
        });
      }
      return response;
    } catch (error) {
      if (safeShouldReport(url, shouldReport) && !isAbortError(error)) {
        reportNetworkError({
          source,
          url,
          method,
          durationMs: Date.now() - startedAt,
          error,
          timedOut: isRequestDeadlineError(error),
        });
      }
      throw error;
    }
  };
}
