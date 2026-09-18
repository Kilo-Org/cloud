import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { timingMiddleware } from './init';

type TimingOpts = Parameters<typeof timingMiddleware>[0];

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.2.3',
  'x-kilo-request-id': 'req-123',
};

const EXTENSION_HEADERS = { 'x-kilo-client': 'extension' };

function mobileCtx() {
  return { user: { id: 'u1' }, headersList: new Headers(MOBILE_HEADERS) };
}

function extensionCtx() {
  return { user: { id: 'u1' }, headersList: new Headers(EXTENSION_HEADERS) };
}

function runTiming(
  overrides: {
    path?: string;
    type?: TimingOpts['type'];
    ctx?: unknown;
    next?: () => Promise<{ ok: boolean }>;
  } = {}
): Promise<{ ok: boolean }> {
  return timingMiddleware({
    path: overrides.path ?? 'user.getMe',
    type: overrides.type ?? 'query',
    ctx: overrides.ctx ?? mobileCtx(),
    next: overrides.next ?? (async () => ({ ok: true })),
  } as unknown as TimingOpts);
}

let savedLogging: string | undefined;
let savedSampleRate: string | undefined;
let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  savedLogging = process.env.TRPC_TIMING_LOGGING;
  savedSampleRate = process.env.TRPC_TIMING_SAMPLE_RATE;
  process.env.TRPC_TIMING_LOGGING = '1';
  delete process.env.TRPC_TIMING_SAMPLE_RATE;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (savedLogging === undefined) delete process.env.TRPC_TIMING_LOGGING;
  else process.env.TRPC_TIMING_LOGGING = savedLogging;
  if (savedSampleRate === undefined) delete process.env.TRPC_TIMING_SAMPLE_RATE;
  else process.env.TRPC_TIMING_SAMPLE_RATE = savedSampleRate;
  jest.restoreAllMocks();
});

function lines(): Record<string, unknown>[] {
  return logSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe('timingMiddleware', () => {
  test('logs a mobile line with the client dimensions and userId', async () => {
    const result = await runTiming();

    expect(result).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toMatchObject({
      type: 'trpc_timing',
      surface: 'trpc',
      path: 'user.getMe',
      procedureType: 'query',
      ok: true,
      client: 'mobile',
      platform: 'ios',
      version: '1.2.3',
      requestId: 'req-123',
      userId: 'u1',
    });
    expect(lines()[0].durationMs).toEqual(expect.any(Number));
  });

  test('always logs mobile even at rate 0', async () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '0';

    await runTiming();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toMatchObject({ client: 'mobile', userId: 'u1' });
  });

  test('emits nothing for a non-mobile request at rate 0', async () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '0';

    await runTiming({ path: 'kiloPass.getState', ctx: extensionCtx() });

    expect(logSpy).not.toHaveBeenCalled();
  });

  test('logs a sampled non-mobile line without userId', async () => {
    process.env.TRPC_TIMING_SAMPLE_RATE = '1';

    await runTiming({ path: 'kiloPass.getState', ctx: extensionCtx() });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = lines();
    expect(line).toMatchObject({
      type: 'trpc_timing',
      path: 'kiloPass.getState',
      client: 'extension',
    });
    expect(line).not.toHaveProperty('userId');
  });

  test('emits nothing when TRPC_TIMING_LOGGING is unset', async () => {
    delete process.env.TRPC_TIMING_LOGGING;
    process.env.TRPC_TIMING_SAMPLE_RATE = '1';

    await runTiming();

    expect(logSpy).not.toHaveBeenCalled();
  });
});
