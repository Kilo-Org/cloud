/* oxlint-disable max-lines -- cohesive network-error policy: reading the tRPC error, normalizing the URL, and building the fingerprint and event share one set of total helpers */
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
import { NETWORK_BODY_CONTEXT } from '@/lib/telemetry/sentry-scrub';

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

// `Error` and `DOMException` both carry a string `name`; abort/deadline checks
// key on it so a structured error never needs an `instanceof` across bundles.
const NamedErrorSchema = z.looseObject({ name: z.string() });

// Expo SDK 57's fetch rejects a canceled request with a
// `FetchRequestCanceledException`: a raw native error carries it as `name`, an
// expo-modules-core `CodedError` as `code`, and the `FetchError` wrapper (whose
// `name` is `Error`) embeds it in `message`.
const ErrorCodeSchema = z.looseObject({ code: z.string() });
const ErrorMessageSchema = z.looseObject({ message: z.string() });
const ErrorCauseSchema = z.looseObject({ cause: z.unknown() });

const EXPO_CANCEL_NAME = 'FetchRequestCanceledException';
const ABORT_ERROR_NAME = 'AbortError';

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

/** The `scheme://host[:port]` prefix of an absolute URL. */
const URL_ORIGIN_PREFIX_PATTERN = /^[a-z][\da-z+.-]*:\/\/[^/]*/iu;

/**
 * Reduce a URL to the path that names the endpoint: drop the scheme, the host,
 * the port, and the query string. A dev backend's port is ephemeral, so
 * keeping it in a fingerprint splits one defect into one issue per port, and
 * the same value makes the message title unstable. Total: `''` for a
 * non-string, `'/'` for an absolute URL with no path.
 */
export function normalizeUrlPath(url: string): string {
  try {
    const pathOnly = stripQueryString(url);
    if (pathOnly.length === 0) {
      return '';
    }
    const path = pathOnly.replace(URL_ORIGIN_PREFIX_PATTERN, '');
    return path.length > 0 ? path : '/';
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

/**
 * True when the value is an abort: an `AbortError` / `DOMException` or an Expo
 * `FetchRequestCanceledException`. The Expo cancellation is checked on the
 * error itself and one level of `cause`, since the SDK wraps it. Total: an
 * unrecognized value yields `false` and never throws.
 */
export function isAbortError(error: unknown): boolean {
  try {
    if (hasErrorName(error, ABORT_ERROR_NAME) || isExpoCanceledError(error)) {
      return true;
    }
    const parsed = ErrorCauseSchema.safeParse(error);
    return parsed.success && parsed.data.cause !== undefined
      ? isExpoCanceledError(parsed.data.cause)
      : false;
  } catch {
    return false;
  }
}

function isExpoCanceledError(error: unknown): boolean {
  try {
    if (hasErrorName(error, EXPO_CANCEL_NAME)) {
      return true;
    }
    const byCode = ErrorCodeSchema.safeParse(error);
    if (byCode.success && byCode.data.code === EXPO_CANCEL_NAME) {
      return true;
    }
    const byMessage = ErrorMessageSchema.safeParse(error);
    return byMessage.success && byMessage.data.message.includes(EXPO_CANCEL_NAME);
  } catch {
    return false;
  }
}

function hasErrorName(error: unknown, name: string): boolean {
  try {
    const parsed = NamedErrorSchema.safeParse(error);
    return parsed.success && parsed.data.name === name;
  } catch {
    return false;
  }
}

function isRequestDeadlineError(error: unknown): boolean {
  return hasErrorName(error, 'RequestDeadlineError');
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

/**
 * The fingerprint's outcome key: the specific HTTP status when there is one,
 * otherwise the tRPC code, otherwise the coarse transport outcome. The old
 * `statusClass` ('4xx') grouped a 401 and a 412 of the same procedure into one
 * issue, merging two different root causes.
 */
function fingerprintOutcome(context: NetworkErrorContext, trpc: TrpcErrorContext): string {
  const httpStatus = context.status ?? trpc.httpStatus;
  if (httpStatus !== undefined) {
    return `http.${httpStatus}`;
  }
  if (trpc.code !== undefined) {
    return trpc.code;
  }
  return networkOutcome(context);
}

/** The exception type of every error this module synthesizes. */
const SYNTHETIC_ERROR_NAME = 'NetworkError';

/**
 * A real `Error` with a stable message for a context that carries no `Error`
 * of its own. Never a plain object: Sentry titles such an event from an SDK
 * frame (`Scope#captureException`) instead of the defect. The message holds
 * only the normalized path and the specific status/code, never the ephemeral
 * port or the query string.
 */
function buildSyntheticError(
  context: NetworkErrorContext,
  path: string,
  trpc: TrpcErrorContext
): Error {
  const method = context.method ?? 'GET';
  const status = context.status ?? trpc.httpStatus;
  const detail = status === undefined ? trpc.code : String(status);
  const error = new Error(
    detail === undefined ? `${method} ${path} failed` : `${method} ${path} -> ${detail}`
  );
  error.name = SYNTHETIC_ERROR_NAME;
  return error;
}

/**
 * Build and emit one warning-level telemetry event for a network error.
 * Never throws; never includes headers, bodies, or query strings.
 */
export function reportNetworkError(context: NetworkErrorContext): void {
  try {
    const pathOnly = stripQueryString(context.url);
    const normalizedPath = normalizeUrlPath(context.url);
    const procedure = trpcProcedureFromUrl(context.url);
    const trpc = readTrpcErrorContext(context.error);
    const trpcCode = trpc.code;
    const statusClass = statusClassFor(context.status);
    const outcome = networkOutcome(context);
    const passedError = context.error instanceof Error ? context.error : undefined;
    const error = passedError ?? buildSyntheticError(context, normalizedPath, trpc);

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
    };

    // A non-`Error` context (a parsed tRPC body) rides in the payload context
    // `NETWORK_BODY_CONTEXT`, which `scrubEvent` walks and token-redacts.
    // Passing it to `captureException` would both leak and title the issue from
    // an SDK frame, and keying it on the synthesized exception's class name
    // would be overwritten with `{}` by `extraErrorDataIntegration` (which owns
    // `contexts[error.name]`).
    const contexts = {
      network,
      ...(passedError === undefined && context.error !== undefined
        ? { [NETWORK_BODY_CONTEXT]: { data: context.error } }
        : {}),
    };

    captureTelemetry({
      level: 'warning',
      error,
      tags,
      contexts,
      fingerprint: [
        'network-error',
        context.source,
        procedure ?? normalizedPath,
        fingerprintOutcome(context, trpc),
      ],
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
