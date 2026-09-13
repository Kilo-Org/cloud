import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMock = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/react-native', () => sentryMock);

type InstallFn = () => void;

// Fast Refresh can call installErrorReporting repeatedly, so each test loads a
// fresh module registry to exercise the module-level idempotency guard.
async function loadInstallErrorReporting(): Promise<InstallFn> {
  vi.resetModules();
  const mod = await import('./install-error-reporting');
  return mod.installErrorReporting;
}

const baseFetch = vi.fn();

beforeEach(() => {
  sentryMock.captureException.mockClear();
  sentryMock.captureMessage.mockClear();
  baseFetch.mockReset();
  vi.stubGlobal('fetch', baseFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installErrorReporting', () => {
  it('routes an error event to captureException at warning level', async () => {
    const install = await loadInstallErrorReporting();
    install();
    const { captureTelemetry } = await import('@/lib/telemetry/error-sink');

    const error = new Error('boom');
    captureTelemetry({ level: 'warning', error, tags: { 'error.source': 'fetch' } });

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ level: 'warning', tags: { 'error.source': 'fetch' } })
    );
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it('routes a message event to captureMessage', async () => {
    const install = await loadInstallErrorReporting();
    install();
    const { captureTelemetry } = await import('@/lib/telemetry/error-sink');

    captureTelemetry({ level: 'error', message: 'network down' });

    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      'network down',
      expect.objectContaining({ level: 'error' })
    );
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('wraps the global fetch and reports a failing non-tRPC http request', async () => {
    const install = await loadInstallErrorReporting();
    install();

    const wrapped = globalThis.fetch;
    expect(wrapped).not.toBe(baseFetch);

    const failure = new Error('network down');
    baseFetch.mockRejectedValue(failure);

    await expect(wrapped('https://api.example.com/health')).rejects.toBe(failure);

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('reports a >=400 response from a non-tRPC http request', async () => {
    const install = await loadInstallErrorReporting();
    install();

    baseFetch.mockResolvedValue(new Response('bad gateway', { status: 502 }));

    const response = await globalThis.fetch('https://api.example.com/health');

    expect(response.status).toBe(502);
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
  });

  it('skips /api/trpc URLs (the tRPC links own those)', async () => {
    const install = await loadInstallErrorReporting();
    install();

    const failure = new Error('trpc down');
    baseFetch.mockRejectedValue(failure);

    await expect(
      globalThis.fetch('https://api.example.com/api/trpc/session.list?batch=1')
    ).rejects.toBe(failure);

    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('skips non-http URLs', async () => {
    const install = await loadInstallErrorReporting();
    install();

    const failure = new Error('file missing');
    baseFetch.mockRejectedValue(failure);

    await expect(globalThis.fetch('file:///tmp/data')).rejects.toBe(failure);

    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('skips telemetry hosts so the SDK never observes itself', async () => {
    const install = await loadInstallErrorReporting();
    install();

    const sdkFailure = new Error('sdk transport down');

    baseFetch.mockRejectedValueOnce(sdkFailure);
    await expect(globalThis.fetch('https://us.i.posthog.com/batch/')).rejects.toBe(sdkFailure);

    baseFetch.mockRejectedValueOnce(sdkFailure);
    await expect(globalThis.fetch('https://o1.ingest.sentry.io/api/1/store/')).rejects.toBe(
      sdkFailure
    );

    baseFetch.mockRejectedValueOnce(sdkFailure);
    await expect(globalThis.fetch('https://api2.appsflyer.com/event')).rejects.toBe(sdkFailure);

    baseFetch.mockRejectedValueOnce(sdkFailure);
    await expect(globalThis.fetch('https://u.expo.dev/manifest')).rejects.toBe(sdkFailure);

    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('does not wrap twice when called again', async () => {
    const install = await loadInstallErrorReporting();
    install();
    const first = globalThis.fetch;

    install();

    expect(globalThis.fetch).toBe(first);

    baseFetch.mockRejectedValue(new Error('once'));
    await expect(first('https://api.example.com/health')).rejects.toThrow('once');

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
  });
});
