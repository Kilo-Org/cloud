import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMock = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/react-native', () => sentryMock);

// The latency sink host is derived from the resolved config, so the mock keeps
// the module binding live: a test can swap in an override without a second
// module registry.
const configMock = vi.hoisted(() => ({
  latencyIngestUrl: 'https://latency.kiloapps.io' as string | undefined,
}));

vi.mock('@/lib/config', () => ({
  get LATENCY_INGEST_URL() {
    return configMock.latencyIngestUrl;
  },
}));

type InstallFn = () => void;

// Fast Refresh can re-evaluate the module, so each test loads a fresh module
// registry to exercise the guard the way a refresh would.
async function loadInstallErrorReporting(): Promise<InstallFn> {
  vi.resetModules();
  const mod = await import('./install-error-reporting');
  return mod.installErrorReporting;
}

const baseFetch = vi.fn();

// The install guard lives on `globalThis` (Fast Refresh keeps globals), so
// each test must clear it to exercise a fresh install.
const INSTALLED_FLAG = '__kiloErrorReportingInstalled__';

beforeEach(() => {
  sentryMock.captureException.mockClear();
  sentryMock.captureMessage.mockClear();
  configMock.latencyIngestUrl = 'https://latency.kiloapps.io';
  baseFetch.mockReset();
  vi.stubGlobal('fetch', baseFetch);
  vi.stubGlobal(INSTALLED_FLAG, undefined);
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

  // KILO-APP-293: the app's own fire-and-forget latency POST answered 504 and
  // was reported as a user-facing network error, although `postLatencyBatch`
  // swallows every outcome and the user never waits on it.
  it("skips the app's own latency sink so a 504 from it is not a user-facing error", async () => {
    const install = await loadInstallErrorReporting();
    install();

    baseFetch.mockResolvedValue(new Response('gateway timeout', { status: 504 }));

    const response = await globalThis.fetch('https://latency.kiloapps.io/v1/latency', {
      method: 'POST',
    });

    expect(response.status).toBe(504);
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it('excludes an overridden latency ingest host too', async () => {
    configMock.latencyIngestUrl = 'https://latency-staging.example.com';
    const install = await loadInstallErrorReporting();
    install();

    baseFetch.mockResolvedValue(new Response('gateway timeout', { status: 504 }));

    await globalThis.fetch('https://latency-staging.example.com/v1/latency', { method: 'POST' });

    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  // The exclusion is scoped to the app's own sink: the control plane still
  // reports. The global wrapper skips `/api/trpc` (the tRPC links own those),
  // so the reporter that owns a control-plane call is the one lib/trpc.ts
  // builds at `observedFetch` (lib/trpc.ts:108). It is rebuilt here with the
  // same options so the assertion runs against the sink `install()` wired.
  it('still reports a control-plane 504 through the tRPC reporter', async () => {
    const install = await loadInstallErrorReporting();
    install();

    const { createNetworkErrorFetch, readTrpcResponseError } =
      await import('@/lib/telemetry/network-errors');
    // A resolving fake fetch via `vi.fn`, the shape the sibling suite uses:
    // an inline `async () => new Response(...)` trips both `require-await`
    // (no await) and `promise-function-async` once the async is dropped.
    const gatewayTimeoutFetch = vi.fn();
    gatewayTimeoutFetch.mockResolvedValue(new Response('gateway timeout', { status: 504 }));
    const observedFetch = createNetworkErrorFetch(gatewayTimeoutFetch as unknown as typeof fetch, {
      source: 'trpc',
      isResponseError: status => status >= 400 || status === 207,
      readResponseError: readTrpcResponseError,
    });

    await observedFetch('https://api.kilo.ai/api/trpc/activeSessions.list?batch=1', {
      method: 'POST',
    });

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          'error.subsystem': 'network',
          'error.source': 'trpc',
          'network.outcome': 'http_error',
        }),
        contexts: expect.objectContaining({
          network: expect.objectContaining({
            url: 'https://api.kilo.ai/api/trpc/activeSessions.list',
            status: 504,
          }),
        }),
      })
    );
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

  it('does not stack wrappers when a fresh module instance installs again', async () => {
    const install = await loadInstallErrorReporting();
    install();
    const first = globalThis.fetch;

    // Fast Refresh re-evaluates install-error-reporting.ts; the globalThis
    // guard must survive the fresh module instance.
    const installAfterRefresh = await loadInstallErrorReporting();
    installAfterRefresh();

    expect(globalThis.fetch).toBe(first);

    baseFetch.mockRejectedValue(new Error('refreshed'));
    await expect(first('https://api.example.com/health')).rejects.toThrow('refreshed');

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
  });
});
