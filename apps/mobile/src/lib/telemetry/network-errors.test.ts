/* oxlint-disable max-lines -- one network-error suite; splitting the fetch and unit cases would duplicate the fake-sink scaffold */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import {
  createNetworkErrorFetch,
  isAbortError,
  type NetworkErrorContext,
  normalizeUrlPath,
  readTrpcErrorContext,
  readTrpcResponseError,
  reportNetworkError,
  stripQueryString,
  trpcProcedureFromUrl,
} from '@/lib/telemetry/network-errors';
import { NETWORK_BODY_CONTEXT } from '@/lib/telemetry/sentry-scrub';

let events: TelemetryEvent[] = [];

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  setTelemetrySink(null);
});

function reportedEvent(): TelemetryEvent | undefined {
  return events.at(-1);
}

function errorMessageOf(event: TelemetryEvent | undefined): string {
  const error = event?.error;
  return error instanceof Error ? error.message : '';
}

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function rejectingFetch(error: unknown): typeof fetch {
  const mock = vi.fn();
  mock.mockRejectedValue(error);
  return mock as unknown as typeof fetch;
}

function resolvingFetch(response: Response): typeof fetch {
  const mock = vi.fn();
  mock.mockResolvedValue(response);
  return mock as unknown as typeof fetch;
}

describe('stripQueryString', () => {
  it('drops the query string', () => {
    expect(stripQueryString('https://example.com/api/trpc/a.b?batch=1&input=secret')).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });

  it('leaves a query-free URL unchanged', () => {
    expect(stripQueryString('https://example.com/api/trpc/a.b')).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });
});

describe('normalizeUrlPath', () => {
  it('drops the scheme, host, and ephemeral port and keeps the path', () => {
    expect(normalizeUrlPath('http://127.0.0.1:10416/v1/latency')).toBe('/v1/latency');
    expect(normalizeUrlPath('http://127.0.0.1:10216/v1/latency')).toBe('/v1/latency');
    expect(normalizeUrlPath('https://api.example.com/api/trpc/session.list?batch=1')).toBe(
      '/api/trpc/session.list'
    );
  });

  it('keeps a path-only URL unchanged', () => {
    expect(normalizeUrlPath('/api/trpc/a.b')).toBe('/api/trpc/a.b');
  });

  it('returns / for an absolute URL with no path and empty for a non-string', () => {
    expect(normalizeUrlPath('https://api.example.com')).toBe('/');
    expect(normalizeUrlPath(undefined as unknown as string)).toBe('');
  });
});

describe('trpcProcedureFromUrl', () => {
  it('extracts the procedure with the query stripped', () => {
    expect(trpcProcedureFromUrl('https://example.com/api/trpc/session.list?batch=1')).toBe(
      'session.list'
    );
  });

  it('extracts a batched procedure list', () => {
    expect(trpcProcedureFromUrl('https://example.com/api/trpc/a.b,c.d?batch=1')).toBe('a.b,c.d');
  });

  it('returns undefined for a non-trpc URL', () => {
    expect(trpcProcedureFromUrl('https://example.com/health')).toBeUndefined();
  });
});

describe('readTrpcErrorContext', () => {
  it('reads direct data.* metadata', () => {
    const error = {
      data: { code: 'TIMEOUT', httpStatus: 504, path: 'session.list', message: 'late' },
    };
    expect(readTrpcErrorContext(error)).toEqual({
      code: 'TIMEOUT',
      httpStatus: 504,
      path: 'session.list',
      message: 'late',
    });
  });

  it('reads shaped shape.data.* metadata', () => {
    const error = {
      shape: { data: { code: 'UNAUTHORIZED', httpStatus: 401, path: 'user.me', message: 'no' } },
    };
    expect(readTrpcErrorContext(error)).toEqual({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      path: 'user.me',
      message: 'no',
    });
  });

  it('falls back to the top-level code and Error message', () => {
    expect(readTrpcErrorContext(namedError('Error', 'plain failure'))).toEqual({
      code: undefined,
      httpStatus: undefined,
      path: undefined,
      message: 'plain failure',
    });
  });

  it('returns an empty context for an unrecognized value', () => {
    expect(readTrpcErrorContext('not an error')).toEqual({
      code: undefined,
      httpStatus: undefined,
      path: undefined,
      message: undefined,
    });
  });
});

describe('readTrpcResponseError', () => {
  const batchError = {
    message: 'forbidden',
    code: -32_003,
    data: { code: 'FORBIDDEN', httpStatus: 403, path: 'session.list' },
  };

  it('returns the error item from a batched array without consuming the response', async () => {
    const body = [{ result: { data: 'ok' } }, { error: batchError }];
    const response = Response.json(body, { status: 207 });

    await expect(readTrpcResponseError(response)).resolves.toEqual(batchError);
    // The original body is still readable: only the clone was consumed.
    await expect(response.json()).resolves.toEqual(body);
  });

  it('returns a top-level error object', async () => {
    const response = Response.json({ error: batchError }, { status: 500 });

    await expect(readTrpcResponseError(response)).resolves.toEqual(batchError);
  });

  it('returns undefined for a success-only array', async () => {
    const response = Response.json([{ result: { data: 'ok' } }], { status: 200 });

    await expect(readTrpcResponseError(response)).resolves.toBeUndefined();
  });

  it('returns undefined for a non-JSON body', async () => {
    const response = new Response('<html>nope</html>', { status: 502 });

    await expect(readTrpcResponseError(response)).resolves.toBeUndefined();
  });

  it('returns undefined when clone() throws', async () => {
    const response = {
      clone() {
        throw new Error('body already consumed');
      },
    } as unknown as Response;

    await expect(readTrpcResponseError(response)).resolves.toBeUndefined();
  });
});

describe('isAbortError', () => {
  it('is true for an AbortError by name', () => {
    expect(isAbortError(namedError('AbortError'))).toBe(true);
  });

  it('is false for other errors and non-errors', () => {
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('is true for an Expo FetchError cancellation by message', () => {
    const error = new Error(
      'fetch failed: FetchRequestCanceledException: Fetch request has been canceled'
    );
    expect(error.name).toBe('Error');
    expect(isAbortError(error)).toBe(true);
  });

  it('is true for an expo-modules-core CodedError cancellation by code', () => {
    const error = {
      code: 'FetchRequestCanceledException',
      message: 'Fetch request has been canceled',
    };
    expect(isAbortError(error)).toBe(true);
  });

  it('is true for a raw FetchRequestCanceledException by name', () => {
    expect(isAbortError(namedError('FetchRequestCanceledException'))).toBe(true);
  });

  it('is true when the cancellation is nested one level under cause', () => {
    const cause = { code: 'FetchRequestCanceledException' };
    expect(isAbortError({ message: 'wrapped', cause })).toBe(true);
  });
});

describe('createNetworkErrorFetch', () => {
  it('(a) reports one warning event for a fetch rejection and re-throws the original error', async () => {
    const original = new Error('socket closed');
    const wrapped = createNetworkErrorFetch(rejectingFetch(original), { source: 'trpc' });

    await expect(wrapped('https://example.com/api/trpc/session.list?batch=1')).rejects.toBe(
      original
    );

    expect(events).toHaveLength(1);
    const event = reportedEvent();
    expect(event?.level).toBe('warning');
    expect(event?.error).toBe(original);
    expect(event?.tags).toMatchObject({
      'error.subsystem': 'network',
      'error.source': 'trpc',
      'network.outcome': 'failed',
      'trpc.procedure': 'session.list',
    });
    expect(event?.contexts?.network).toMatchObject({
      url: 'https://example.com/api/trpc/session.list',
      outcome: 'failed',
      procedure: 'session.list',
    });
    expect(typeof event?.contexts?.network?.durationMs).toBe('number');
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'failed']);
  });

  it('(b) does not report an aborted request and re-throws it', async () => {
    const abort = namedError('AbortError');
    const wrapped = createNetworkErrorFetch(rejectingFetch(abort));

    await expect(wrapped('https://example.com/api/trpc/session.list')).rejects.toBe(abort);

    expect(events).toHaveLength(0);
  });

  it('(b2) does not report an Expo FetchRequestCanceledException and re-throws it', async () => {
    const cancel = new Error(
      'fetch failed: FetchRequestCanceledException: Fetch request has been canceled'
    );
    const wrapped = createNetworkErrorFetch(rejectingFetch(cancel), { source: 'trpc' });

    await expect(wrapped('https://example.com/api/trpc/session.list')).rejects.toBe(cancel);

    expect(events).toHaveLength(0);
  });

  it('(c) marks a RequestDeadlineError as a timeout', async () => {
    const deadline = namedError('RequestDeadlineError', 'Request timed out after 15000ms');
    const wrapped = createNetworkErrorFetch(rejectingFetch(deadline), { source: 'trpc' });

    await expect(wrapped('https://example.com/api/trpc/session.list')).rejects.toBe(deadline);

    expect(events).toHaveLength(1);
    const event = reportedEvent();
    expect(event?.tags).toMatchObject({
      'network.outcome': 'timeout',
      'trpc.procedure': 'session.list',
    });
    expect(event?.contexts?.network).toMatchObject({ outcome: 'timeout', timedOut: true });
    expect(event?.error).toBe(deadline);
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'timeout']);
  });

  it('(d) reports a 500 response and returns the same response unchanged', async () => {
    const response = new Response('server error', {
      status: 500,
      statusText: 'Internal Server Error',
    });
    const wrapped = createNetworkErrorFetch(resolvingFetch(response), { source: 'trpc' });

    const result = await wrapped('https://example.com/api/trpc/session.list');

    expect(result).toBe(response);
    expect(events).toHaveLength(1);
    const event = reportedEvent();
    expect(event?.level).toBe('warning');
    expect(event?.tags).toMatchObject({
      'error.subsystem': 'network',
      'error.source': 'trpc',
      'http.status': 500,
      'http.status_class': '5xx',
      'network.outcome': 'http_error',
      'trpc.procedure': 'session.list',
    });
    expect(event?.contexts?.network).toMatchObject({
      url: 'https://example.com/api/trpc/session.list',
      status: 500,
      statusText: 'Internal Server Error',
      outcome: 'http_error',
    });
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'http.500']);
    expect(event?.error).toBeInstanceOf(Error);
  });

  it('(d2) reports a 404 with a synthesized <METHOD> <path> -> <status> error', async () => {
    const response = new Response('missing', { status: 404, statusText: 'Not Found' });
    const wrapped = createNetworkErrorFetch(resolvingFetch(response));

    await wrapped('https://example.com/api/trpc/a.b', { method: 'POST' });

    const event = reportedEvent();
    expect(event?.tags).toMatchObject({
      'http.method': 'POST',
      'http.status': 404,
      'http.status_class': '4xx',
      'network.outcome': 'http_error',
    });
    expect(event?.fingerprint).toEqual(['network-error', 'fetch', 'a.b', 'http.404']);
    // The message drops the scheme, host, and port so it is stable across
    // environments and worktrees.
    expect(errorMessageOf(event)).toBe('POST /api/trpc/a.b -> 404');
  });

  it('(e) does not report a 200 response', async () => {
    const response = new Response('ok', { status: 200 });
    const wrapped = createNetworkErrorFetch(resolvingFetch(response));

    const result = await wrapped('https://example.com/api/trpc/a.b');

    expect(result).toBe(response);
    expect(events).toHaveLength(0);
  });

  it('(f) does not report a non-http URL', async () => {
    const error = new Error('nope');
    const wrapped = createNetworkErrorFetch(rejectingFetch(error));

    await expect(wrapped('file:///tmp/data')).rejects.toBe(error);

    expect(events).toHaveLength(0);
  });

  it('respects a shouldReport predicate that declines the URL', async () => {
    const error = new Error('nope');
    const wrapped = createNetworkErrorFetch(rejectingFetch(error), {
      shouldReport: () => false,
    });

    await expect(wrapped('https://example.com/api/trpc/a.b')).rejects.toBe(error);

    expect(events).toHaveLength(0);
  });

  it('(g) extracts trpc procedure and direct error code from a rejection', async () => {
    const trpcError = {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'session.list' },
    };
    const wrapped = createNetworkErrorFetch(rejectingFetch(trpcError), { source: 'trpc' });

    await expect(wrapped('https://example.com/api/trpc/session.list?batch=1')).rejects.toBe(
      trpcError
    );

    const event = reportedEvent();
    expect(event?.tags).toMatchObject({
      'trpc.procedure': 'session.list',
      'trpc.code': 'INTERNAL_SERVER_ERROR',
    });
    expect(event?.contexts?.network).toMatchObject({
      procedure: 'session.list',
      trpcCode: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('(h) never includes the query string in any reported field', async () => {
    const url =
      'https://example.com/api/trpc/session.list?batch=1&input=%7B%22token%22%3A%22supersecret%22%7D';
    const error = new Error('failed');
    const wrapped = createNetworkErrorFetch(rejectingFetch(error), { source: 'trpc' });

    await expect(wrapped(url)).rejects.toBe(error);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('input=');
    expect(serialized).not.toContain('batch=1');
    expect(reportedEvent()?.contexts?.network?.url).toBe(
      'https://example.com/api/trpc/session.list'
    );
  });

  it('(i) reports one warning for a 207 batch with the parsed error and keeps the response', async () => {
    const batchError = {
      message: 'forbidden',
      code: -32_003,
      data: { code: 'FORBIDDEN', httpStatus: 403, path: 'session.list' },
    };
    const body = [{ result: { data: 'ok' } }, { error: batchError }];
    const response = Response.json(body, {
      status: 207,
      statusText: 'Multi-Status',
    });
    const wrapped = createNetworkErrorFetch(resolvingFetch(response), {
      source: 'trpc',
      isResponseError: status => status >= 400 || status === 207,
      readResponseError: readTrpcResponseError,
    });

    const result = await wrapped('https://example.com/api/trpc/session.list?batch=1');

    expect(result).toBe(response);
    expect(events).toHaveLength(1);
    const event = reportedEvent();
    expect(event?.level).toBe('warning');
    expect(event?.tags).toMatchObject({
      'error.subsystem': 'network',
      'error.source': 'trpc',
      'http.status': 207,
      'network.outcome': 'http_error',
      'trpc.procedure': 'session.list',
      'trpc.code': 'FORBIDDEN',
    });
    expect(event?.contexts?.network).toMatchObject({
      url: 'https://example.com/api/trpc/session.list',
      status: 207,
      statusText: 'Multi-Status',
      outcome: 'http_error',
      trpcCode: 'FORBIDDEN',
    });
    // The parsed tRPC body is not passed to `captureException` (Sentry would
    // title the issue from an SDK frame): a real Error carries the stable
    // message and the body rides in the payload context `scrubEvent` redacts.
    expect(event?.error).toBeInstanceOf(Error);
    expect(errorMessageOf(event)).toBe('GET /api/trpc/session.list -> 403');
    expect(event?.contexts?.[NETWORK_BODY_CONTEXT]).toEqual({ data: batchError });
    // Keyed away from the synthesized exception name: that context is owned by
    // `extraErrorDataIntegration`, which would overwrite it with `{}`.
    expect(event?.contexts?.NetworkError).toBeUndefined();
    // The inner status names the defect; the 207 envelope only says the body
    // is a batch, so keying on it would merge a 403 and a 500 of one procedure.
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'http.403']);
  });

  it('(i2) keys a 207 batch on the parsed inner status, not the envelope', async () => {
    const report = async (httpStatus: number | undefined, code: string) => {
      const body = [
        { result: { data: 'ok' } },
        {
          error: {
            message: 'failed',
            code: -32_000,
            data: {
              code,
              ...(httpStatus === undefined ? {} : { httpStatus }),
              path: 'session.list',
            },
          },
        },
      ];
      const response = Response.json(body, { status: 207, statusText: 'Multi-Status' });
      const wrapped = createNetworkErrorFetch(resolvingFetch(response), {
        source: 'trpc',
        isResponseError: status => status >= 400 || status === 207,
        readResponseError: readTrpcResponseError,
      });

      await wrapped('https://example.com/api/trpc/session.list?batch=1');
      return reportedEvent();
    };

    const forbidden = await report(403, 'FORBIDDEN');
    const serverError = await report(500, 'INTERNAL_SERVER_ERROR');
    // With no inner status the tRPC code keys the group, never the envelope.
    const noInnerStatus = await report(undefined, 'TOO_MANY_REQUESTS');

    expect(forbidden?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'http.403']);
    expect(serverError?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'http.500']);
    expect(noInnerStatus?.fingerprint).toEqual([
      'network-error',
      'trpc',
      'session.list',
      'TOO_MANY_REQUESTS',
    ]);
    expect(serverError?.fingerprint).not.toEqual(forbidden?.fingerprint);
    expect(errorMessageOf(forbidden)).toBe('GET /api/trpc/session.list -> 403');
    expect(errorMessageOf(serverError)).toBe('GET /api/trpc/session.list -> 500');
  });

  it('(j) ignores a 207 when no options opt it in', async () => {
    const body = [{ result: { data: 'ok' } }, { error: { data: { code: 'FORBIDDEN' } } }];
    const response = Response.json(body, { status: 207 });
    const wrapped = createNetworkErrorFetch(resolvingFetch(response));

    const result = await wrapped('https://example.com/api/trpc/session.list?batch=1');

    expect(result).toBe(response);
    expect(events).toHaveLength(0);
  });
});

describe('reportNetworkError', () => {
  it('produces a stable fingerprint across repeated identical reports', () => {
    const context: NetworkErrorContext = {
      source: 'fetch',
      url: 'https://example.com/api/trpc/a.b?input=secret',
      method: 'POST',
      durationMs: 3,
      error: new Error('failed'),
    };

    reportNetworkError(context);
    reportNetworkError(context);

    expect(events).toHaveLength(2);
    expect(events[0]?.fingerprint).toEqual(events[1]?.fingerprint);
    expect(events[0]?.fingerprint).toEqual(['network-error', 'fetch', 'a.b', 'failed']);
  });

  it('synthesizes a failure message without a status', () => {
    reportNetworkError({
      source: 'fetch',
      url: 'https://example.com/health',
      method: 'GET',
      durationMs: 1234,
    });

    const event = reportedEvent();
    expect(errorMessageOf(event)).toBe('GET /health failed');
    expect(event?.contexts?.network).toMatchObject({
      url: 'https://example.com/health',
      method: 'GET',
      durationMs: 1234,
      outcome: 'failed',
    });
    expect(event?.fingerprint).toEqual(['network-error', 'fetch', '/health', 'failed']);
  });

  it('groups one defect across the ephemeral dev port', () => {
    const report = (port: number) => {
      reportNetworkError({
        source: 'fetch',
        url: `http://127.0.0.1:${port}/v1/latency`,
        method: 'POST',
        status: 401,
        durationMs: 4,
      });
      return reportedEvent();
    };

    const first = report(10_416);
    const second = report(10_216);

    expect(first?.fingerprint).toEqual(['network-error', 'fetch', '/v1/latency', 'http.401']);
    expect(second?.fingerprint).toEqual(first?.fingerprint);
    expect(errorMessageOf(second)).toBe(errorMessageOf(first));
    expect(errorMessageOf(first)).toBe('POST /v1/latency -> 401');
  });

  it('separates two outcomes of one procedure (401 against 412)', () => {
    const report = (status: number) => {
      reportNetworkError({
        source: 'trpc',
        url: 'http://127.0.0.1:10416/api/trpc/activeSessions.createWebTicket',
        method: 'POST',
        status,
        durationMs: 6,
      });
      return reportedEvent();
    };

    const unauthorized = report(401);
    const precondition = report(412);

    expect(unauthorized?.fingerprint).toEqual([
      'network-error',
      'trpc',
      'activeSessions.createWebTicket',
      'http.401',
    ]);
    expect(precondition?.fingerprint).toEqual([
      'network-error',
      'trpc',
      'activeSessions.createWebTicket',
      'http.412',
    ]);
  });

  it('keys on the tRPC code when no HTTP status is set', () => {
    reportNetworkError({
      source: 'trpc',
      url: 'https://example.com/api/trpc/session.list',
      method: 'POST',
      durationMs: 5,
      error: { data: { code: 'UNAUTHORIZED', path: 'session.list' } },
    });

    const event = reportedEvent();
    expect(event?.error).toBeInstanceOf(Error);
    expect(errorMessageOf(event)).toBe('POST /api/trpc/session.list -> UNAUTHORIZED');
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'UNAUTHORIZED']);
  });

  it('keeps a real Error and carries a non-Error context in the payload context', () => {
    const original = new Error('socket closed');
    reportNetworkError({
      source: 'fetch',
      url: 'https://example.com/health',
      durationMs: 4,
      error: original,
    });

    expect(reportedEvent()?.error).toBe(original);
    expect(reportedEvent()?.contexts?.[NETWORK_BODY_CONTEXT]).toBeUndefined();

    const body = { data: { code: 'FORBIDDEN' }, message: 'no' };
    reportNetworkError({
      source: 'trpc',
      url: 'https://example.com/api/trpc/a.b',
      durationMs: 4,
      error: body,
    });

    const event = reportedEvent();
    expect(event?.error).toBeInstanceOf(Error);
    expect(event?.error).not.toBe(body);
    expect(event?.contexts?.[NETWORK_BODY_CONTEXT]).toEqual({ data: body });
    // The extra-error-data integration owns `contexts[error.name]` and would
    // replace anything stored there with the error's own (empty) properties.
    expect(event?.contexts?.NetworkError).toBeUndefined();
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'a.b', 'FORBIDDEN']);
  });

  it('reads shaped server error metadata into the trpc.code tag', () => {
    reportNetworkError({
      source: 'trpc',
      url: 'https://example.com/api/trpc/user.me?input=secret',
      durationMs: 5,
      error: { shape: { data: { code: 'UNAUTHORIZED', httpStatus: 401, path: 'user.me' } } },
    });

    const event = reportedEvent();
    expect(event?.tags).toMatchObject({
      'trpc.procedure': 'user.me',
      'trpc.code': 'UNAUTHORIZED',
    });
    expect(event?.contexts?.network).toMatchObject({
      procedure: 'user.me',
      trpcCode: 'UNAUTHORIZED',
    });
  });
});
