/* oxlint-disable max-lines -- one network-error suite; splitting the fetch and unit cases would duplicate the fake-sink scaffold */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import {
  createNetworkErrorFetch,
  isAbortError,
  type NetworkErrorContext,
  readTrpcErrorContext,
  readTrpcResponseError,
  reportNetworkError,
  stripQueryString,
  trpcProcedureFromUrl,
} from '@/lib/telemetry/network-errors';

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
    code: -32003,
    data: { code: 'FORBIDDEN', httpStatus: 403, path: 'session.list' },
  };

  it('returns the error item from a batched array without consuming the response', async () => {
    const body = [{ result: { data: 'ok' } }, { error: batchError }];
    const response = new Response(JSON.stringify(body), { status: 207 });

    await expect(readTrpcResponseError(response)).resolves.toEqual(batchError);
    // The original body is still readable: only the clone was consumed.
    await expect(response.json()).resolves.toEqual(body);
  });

  it('returns a top-level error object', async () => {
    const response = new Response(JSON.stringify({ error: batchError }), { status: 500 });

    await expect(readTrpcResponseError(response)).resolves.toEqual(batchError);
  });

  it('returns undefined for a success-only array', async () => {
    const response = new Response(JSON.stringify([{ result: { data: 'ok' } }]), { status: 200 });

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
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', '5xx']);
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
    expect(event?.fingerprint).toEqual(['network-error', 'fetch', 'a.b', '4xx']);
    expect(errorMessageOf(event)).toBe('POST https://example.com/api/trpc/a.b -> 404');
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
      code: -32003,
      data: { code: 'FORBIDDEN', httpStatus: 403, path: 'session.list' },
    };
    const body = [{ result: { data: 'ok' } }, { error: batchError }];
    const response = new Response(JSON.stringify(body), {
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
    expect(event?.error).toEqual(batchError);
    expect(event?.fingerprint).toEqual(['network-error', 'trpc', 'session.list', 'http_error']);
  });

  it('(j) ignores a 207 when no options opt it in', async () => {
    const body = [{ result: { data: 'ok' } }, { error: { data: { code: 'FORBIDDEN' } } }];
    const response = new Response(JSON.stringify(body), { status: 207 });
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
    expect(errorMessageOf(event)).toBe('GET https://example.com/health failed after 1234ms');
    expect(event?.contexts?.network).toMatchObject({
      url: 'https://example.com/health',
      method: 'GET',
      durationMs: 1234,
      outcome: 'failed',
    });
    expect(event?.fingerprint).toEqual([
      'network-error',
      'fetch',
      'https://example.com/health',
      'failed',
    ]);
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
