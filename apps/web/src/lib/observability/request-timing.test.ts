import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  buildTimingLine,
  isMobileDimensions,
  readClientDimensions,
  shouldLogTiming,
  withRestTiming,
} from './request-timing';

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.2.3',
  'x-kilo-request-id': 'req-123',
};

function parseLines(spy: jest.SpiedFunction<typeof console.log>): Record<string, unknown>[] {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

let savedSampleRate: string | undefined;
let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  savedSampleRate = process.env.TRPC_TIMING_SAMPLE_RATE;
  delete process.env.TRPC_TIMING_SAMPLE_RATE;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (savedSampleRate === undefined) {
    delete process.env.TRPC_TIMING_SAMPLE_RATE;
  } else {
    process.env.TRPC_TIMING_SAMPLE_RATE = savedSampleRate;
  }
  jest.restoreAllMocks();
});

describe('readClientDimensions', () => {
  test('returns null for every dimension when headers are absent', () => {
    expect(readClientDimensions(undefined)).toEqual({
      client: null,
      platform: null,
      version: null,
      requestId: null,
    });
    expect(readClientDimensions(null)).toEqual({
      client: null,
      platform: null,
      version: null,
      requestId: null,
    });
    expect(readClientDimensions(new Headers())).toEqual({
      client: null,
      platform: null,
      version: null,
      requestId: null,
    });
  });

  test('reads the client dimension headers the app sends', () => {
    expect(readClientDimensions(new Headers(MOBILE_HEADERS))).toEqual({
      client: 'mobile',
      platform: 'ios',
      version: '1.2.3',
      requestId: 'req-123',
    });
  });
});

describe('isMobileDimensions', () => {
  test('is exactly the mobile client test', () => {
    expect(isMobileDimensions('mobile')).toBe(true);
    expect(isMobileDimensions('extension')).toBe(false);
    expect(isMobileDimensions(null)).toBe(false);
    expect(isMobileDimensions(undefined)).toBe(false);
  });
});

describe('shouldLogTiming', () => {
  test('always logs mobile, even at rate 0', () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '0';
    expect(shouldLogTiming({ client: 'mobile' })).toBe(true);
  });

  test('never logs a non-mobile client at rate 0', () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '0';
    expect(shouldLogTiming({ client: 'extension' })).toBe(false);
    expect(shouldLogTiming({ client: null })).toBe(false);
  });

  test('logs a non-mobile client at rate 1', () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '1';
    expect(shouldLogTiming({ client: 'extension' })).toBe(true);
  });

  test('falls back to the 0.01 default for a malformed value', () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = 'not-a-number';
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.005);
    expect(shouldLogTiming({ client: 'extension' })).toBe(true);
    random.mockReturnValue(0.5);
    expect(shouldLogTiming({ client: 'extension' })).toBe(false);
  });
});

describe('buildTimingLine', () => {
  test('includes userId only on a mobile line', () => {
    const mobile = buildTimingLine({
      surface: 'trpc',
      path: 'user.getMe',
      procedureType: 'query',
      durationMs: 12,
      ok: true,
      userId: 'u1',
      dimensions: readClientDimensions(new Headers(MOBILE_HEADERS)),
    });
    expect(mobile).toEqual({
      type: 'trpc_timing',
      surface: 'trpc',
      path: 'user.getMe',
      procedureType: 'query',
      durationMs: 12,
      ok: true,
      client: 'mobile',
      platform: 'ios',
      version: '1.2.3',
      requestId: 'req-123',
      userId: 'u1',
    });

    const sampled = buildTimingLine({
      surface: 'trpc',
      path: 'kiloPass.getState',
      procedureType: 'query',
      durationMs: 8,
      ok: true,
      userId: 'u1',
      dimensions: readClientDimensions(new Headers({ 'x-kilo-client': 'extension' })),
    });
    expect(sampled).not.toHaveProperty('userId');
    expect(sampled).toMatchObject({ client: 'extension', type: 'trpc_timing' });
  });
});

describe('withRestTiming', () => {
  // The REST line is sampled like the tRPC line. These cases use requests with
  // no client headers (or mobile headers) and assert unconditional logging, so
  // pin the rate to 100% here; the sampling cases below set their own rate.
  beforeEach(() => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '1';
  });

  test('emits exactly one api_timing line with the exact pattern and client dimensions', async () => {
    const handler = jest.fn<(request: Request, ctx: unknown) => Promise<Response>>(
      async () => new Response('ok', { status: 200 })
    );
    const wrapped = withRestTiming('/api/openrouter/[...path]', handler);
    const request = new Request('https://app.kilo.ai/api/openrouter/chat/completions', {
      method: 'POST',
      headers: MOBILE_HEADERS,
    });
    const ctx = { marker: 'ctx' };

    const response = await wrapped(request, ctx);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(request, ctx);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = parseLines(logSpy);
    expect(line).toMatchObject({
      type: 'api_timing',
      surface: 'rest',
      route: '/api/openrouter/[...path]',
      method: 'POST',
      ok: true,
      client: 'mobile',
      platform: 'ios',
      version: '1.2.3',
      requestId: 'req-123',
    });
    expect(line.durationMs).toEqual(expect.any(Number));
    expect(line).not.toHaveProperty('userId');
  });

  test('logs and re-throws when the handler throws', async () => {
    const failure = new Error('handler exploded');
    const handler = jest.fn(async () => {
      throw failure;
    });
    const wrapped = withRestTiming('/api/openrouter/[...path]', handler);

    await expect(
      wrapped(new Request('https://app.kilo.ai/api/openrouter/chat/completions'), undefined)
    ).rejects.toBe(failure);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = parseLines(logSpy);
    expect(line).toMatchObject({ type: 'api_timing', surface: 'rest', ok: false });
  });

  test('stays silent when the pathname is outside its prefix (gateway re-wrap)', async () => {
    const handler = jest.fn(async () => new Response('ok', { status: 200 }));
    const wrapped = withRestTiming('/api/openrouter/[...path]', handler);

    await wrapped(new Request('https://app.kilo.ai/api/other/route'), undefined);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('checks the static prefix of a dynamic [param] pattern', async () => {
    const handler = jest.fn(async () => new Response('ok', { status: 200 }));
    const wrapped = withRestTiming('/api/sessions/[id]/messages', handler);

    await wrapped(new Request('https://app.kilo.ai/api/sessions/abc/messages'), undefined);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(parseLines(logSpy)[0]).toMatchObject({
      route: '/api/sessions/[id]/messages',
      client: null,
    });

    await wrapped(new Request('https://app.kilo.ai/api/openrouter/chat/completions'), undefined);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  test('a malformed header never throws into the request path', async () => {
    const handler = jest.fn(async () => new Response('ok', { status: 200 }));
    const wrapped = withRestTiming('/api/openrouter/[...path]', handler);
    const request = new Request('https://app.kilo.ai/api/openrouter/chat/completions');
    Object.defineProperty(request, 'headers', {
      get() {
        throw new Error('malformed headers');
      },
    });

    const response = await wrapped(request, undefined);

    expect(response.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(parseLines(logSpy)[0]).toMatchObject({ client: null, requestId: null });
  });

  test('a throwing console.log never throws into the request path', async () => {
    logSpy.mockImplementation(() => {
      throw new Error('log sink down');
    });
    const handler = jest.fn(async () => new Response('ok', { status: 200 }));
    const wrapped = withRestTiming('/api/openrouter/[...path]', handler);

    const response = await wrapped(
      new Request('https://app.kilo.ai/api/openrouter/chat/completions'),
      undefined
    );

    expect(response.status).toBe(200);
  });

  test('logs a server error status as not ok', async () => {
    const handler = jest.fn(async () => new Response('boom', { status: 503 }));
    const wrapped = withRestTiming('/api/openrouter/[...path]', handler);

    await wrapped(new Request('https://app.kilo.ai/api/openrouter/chat/completions'), undefined);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(parseLines(logSpy)[0]).toMatchObject({ ok: false, route: '/api/openrouter/[...path]' });
  });
});

// The extension's model calls land on `/api/gateway/v1/chat/completions` at
// high volume, so a non-mobile REST line is sampled like a tRPC line while
// mobile stays at 100%.
describe('withRestTiming sampling policy', () => {
  const gatewayRequest = (headers?: Record<string, string>) =>
    new Request('https://app.kilo.ai/api/gateway/v1/chat/completions', {
      method: 'POST',
      ...(headers === undefined ? {} : { headers }),
    });

  test('at rate 0, drops extension and no-client lines but logs the mobile line', async () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '0';
    const wrapped = withRestTiming(
      '/api/gateway/[...path]',
      jest.fn(async () => new Response('ok', { status: 200 }))
    );

    await wrapped(gatewayRequest({ 'x-kilo-client': 'extension' }), undefined);
    expect(logSpy).not.toHaveBeenCalled();

    await wrapped(gatewayRequest(), undefined);
    expect(logSpy).not.toHaveBeenCalled();

    await wrapped(gatewayRequest(MOBILE_HEADERS), undefined);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(parseLines(logSpy)[0]).toMatchObject({
      type: 'api_timing',
      client: 'mobile',
      route: '/api/gateway/[...path]',
    });
  });

  test('at rate 1, logs both the extension line and the no-client line', async () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '1';
    const wrapped = withRestTiming(
      '/api/gateway/[...path]',
      jest.fn(async () => new Response('ok', { status: 200 }))
    );

    await wrapped(gatewayRequest({ 'x-kilo-client': 'extension' }), undefined);
    await wrapped(gatewayRequest(), undefined);

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(parseLines(logSpy)).toEqual([
      expect.objectContaining({ type: 'api_timing', client: 'extension' }),
      expect.objectContaining({ type: 'api_timing', client: null }),
    ]);
  });
});
