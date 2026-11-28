// The shared auto-routing clients against an installed sender: which route family (and so which
// scope) every call names, what a process without a sender sends, and how each client answers a
// missing token or a spent deadline. Do not import `jest` from '@jest/globals': the SWC transform
// hoists these `jest.mock` calls only with the global `jest`.
const mockSwitches: Record<string, string | undefined> = {};
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'legacy-internal-secret',
  AUTO_ROUTING_WORKER_URL: 'https://auto-routing.kiloapps.io',
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://auto-routing-benchmark.kiloapps.io',
  get AUTO_ROUTING_DECIDE_SENDER_AUTH() {
    return mockSwitches.AUTO_ROUTING_DECIDE_SENDER_AUTH;
  },
  get GATEWAY_ROUTING_TABLES_SENDER_AUTH() {
    return mockSwitches.GATEWAY_ROUTING_TABLES_SENDER_AUTH;
  },
  get AUTO_ROUTING_ADMIN_SENDER_AUTH() {
    return mockSwitches.AUTO_ROUTING_ADMIN_SENDER_AUTH;
  },
  get AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH() {
    return mockSwitches.AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH;
  },
  get WEB_ROUTING_TABLES_SENDER_AUTH() {
    return mockSwitches.WEB_ROUTING_TABLES_SENDER_AUTH;
  },
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  BENCHMARK_ALIAS_PROMOTION_PATH,
  CUSTOM_ROUTER_BLOCKED_MODELS_PATH,
  CUSTOM_ROUTER_EPOCH_PATH,
  CUSTOM_ROUTER_STATUS_PATH,
  CUSTOM_ROUTER_TABLE_PATH,
  CUSTOM_ROUTER_TABLE_VERSION_PATH,
  PAID_BENCHMARK_ADMIN_PATH,
  PAID_BENCHMARK_ADMIN_PAUSE_PATH,
  PAID_BENCHMARK_ADMIN_PROGRESS_PATH,
  PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH,
  PAID_BENCHMARK_PATH,
  PLATFORM_MEASUREMENTS_PATH,
} from '@kilocode/auto-routing-contracts';
import type {
  AutoRoutingCredential,
  AutoRoutingSender,
  AutoRoutingSenderRoute,
} from './auto-routing-sender';
import type { EfficientDecisionParams } from './auto-routing-decision';

/**
 * The receivers' `GOVERNED_ROUTES`, copied from `services/auto-routing/src/auth.ts` and
 * `services/auto-routing-benchmark/src/auth.ts` on origin/igor/sts-rcv-auto-routing (#13110), each
 * family written as the sender route that names its scope. A `:name` segment matches one segment.
 */
const AUTO_ROUTING_GOVERNED_ROUTES: readonly [string, string, AutoRoutingSenderRoute][] = [
  ['GET', '/admin/classifier-model', 'adminRead'],
  ['PUT', '/admin/classifier-model', 'adminWrite'],
  ['GET', '/admin/routing-mode', 'adminRead'],
  ['PUT', '/admin/routing-mode', 'adminWrite'],
  ['GET', '/admin/classifier-analytics', 'adminRead'],
  ['POST', '/decide', 'decide'],
];
const BENCHMARK_GOVERNED_ROUTES: readonly [string, string, AutoRoutingSenderRoute][] = [
  ['GET', '/admin/routing-table', 'benchmarkRoutingTablesRead'],
  ['GET', '/admin/classifier-winner', 'benchmarkRoutingTablesRead'],
  ['POST', CUSTOM_ROUTER_TABLE_PATH, 'benchmarkRoutingTablesRead'],
  ['POST', CUSTOM_ROUTER_TABLE_VERSION_PATH, 'benchmarkRoutingTablesRead'],
  ['POST', CUSTOM_ROUTER_EPOCH_PATH, 'benchmarkRoutingTablesRead'],

  ['GET', '/admin/config', 'benchmarkAdminRead'],
  ['GET', PLATFORM_MEASUREMENTS_PATH, 'benchmarkAdminRead'],
  ['GET', '/admin/scheduler-config', 'benchmarkAdminRead'],
  ['GET', '/admin/runs', 'benchmarkAdminRead'],
  ['GET', '/admin/runs/:runId/summaries', 'benchmarkAdminRead'],
  ['GET', '/admin/registry', 'benchmarkAdminRead'],
  ['GET', PAID_BENCHMARK_ADMIN_PATH, 'benchmarkAdminRead'],
  ['GET', PAID_BENCHMARK_ADMIN_PROGRESS_PATH, 'benchmarkAdminRead'],
  ['POST', CUSTOM_ROUTER_STATUS_PATH, 'benchmarkAdminRead'],
  ['POST', CUSTOM_ROUTER_BLOCKED_MODELS_PATH, 'benchmarkAdminRead'],
  ['POST', PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH, 'benchmarkAdminRead'],
  ['POST', '/admin/profiles/status', 'benchmarkAdminRead'],
  ['POST', '/admin/custom-routing-table', 'benchmarkAdminRead'],

  ['PUT', '/admin/config', 'benchmarkAdminWrite'],
  ['PUT', '/admin/scheduler-config', 'benchmarkAdminWrite'],
  ['POST', '/admin/runs', 'benchmarkAdminWrite'],
  ['POST', '/admin/runs/:runId/cancel', 'benchmarkAdminWrite'],
  ['POST', '/admin/registry/refresh', 'benchmarkAdminWrite'],
  ['POST', '/admin/registry/requeue', 'benchmarkAdminWrite'],
  ['POST', '/admin/registry/remeasure-prompt-transport', 'benchmarkAdminWrite'],
  ['POST', '/admin/debug-cli', 'benchmarkAdminWrite'],
  ['POST', '/admin/profiles/register', 'benchmarkAdminWrite'],
  ['POST', '/admin/profiles/subscriptions', 'benchmarkAdminWrite'],
  ['POST', BENCHMARK_ALIAS_PROMOTION_PATH, 'benchmarkAdminWrite'],
  ['POST', PAID_BENCHMARK_ADMIN_PAUSE_PATH, 'benchmarkAdminWrite'],
  ['POST', PAID_BENCHMARK_PATH, 'benchmarkAdminWrite'],
];

function governedRoute(method: string, url: URL): AutoRoutingSenderRoute | undefined {
  const table =
    url.host === 'auto-routing-benchmark.kiloapps.io'
      ? BENCHMARK_GOVERNED_ROUTES
      : AUTO_ROUTING_GOVERNED_ROUTES;
  const actual = url.pathname.split('/');
  return table.find(([routeMethod, pattern]) => {
    const expected = pattern.split('/');
    return (
      routeMethod === method &&
      expected.length === actual.length &&
      expected.every((segment, index) =>
        segment.startsWith(':') ? actual[index] !== '' : segment === actual[index]
      )
    );
  })?.[2];
}

// Every client here calls `fetch` with a string URL.
const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of Object.keys(mockSwitches)) delete mockSwitches[key];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ error: 'x' }, { status: 404 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  globalThis.__kilocodeAutoRoutingSender = undefined;
  jest.restoreAllMocks();
});

/** Fresh modules: the sender contract reads the switches once, at load. */
async function loadClients(sender?: AutoRoutingSender) {
  jest.resetModules();
  const contract = await import('./auto-routing-sender');
  if (sender) contract.installAutoRoutingSender(sender);
  return {
    admin: await import('./auto-routing-admin-client'),
    benchmark: await import('./auto-routing-benchmark-admin-client'),
    decision: await import('./auto-routing-decision'),
    adminFetch: await import('./worker-admin-fetch'),
  };
}

const decideParams: EfficientDecisionParams = {
  apiKind: 'chat_completions',
  body: { model: 'kilo-auto/efficient', messages: [{ role: 'user', content: 'Fix the bug.' }] },
  requestedModel: 'kilo-auto/efficient',
  providerHints: { provider: null, providerOptions: null },
  bodyBytes: 64,
  userId: 'user-1',
  organizationId: null,
  sessionId: null,
  machineId: null,
  clientRequestId: null,
  mode: null,
  userAgent: null,
};

function senderAnswering(credential: AutoRoutingCredential): AutoRoutingSender {
  return async () => credential;
}

describe('every admin call names the route family its receiver governs', () => {
  it('pins each call to the scope family of GOVERNED_ROUTES', async () => {
    let lastRoute: AutoRoutingSenderRoute | undefined;
    const { admin, benchmark } = await loadClients(async route => {
      lastRoute = route;
      return { kind: 'legacy' };
    });
    const named: { method: string; url: URL; route: AutoRoutingSenderRoute | undefined }[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      named.push({ method: init?.method ?? 'GET', url: new URL(url), route: lastRoute });
      return Response.json({ error: 'x' }, { status: 404 });
    });
    const context = {
      ownerType: 'org',
      ownerId: 'org-1',
      baseRouter: 'efficient',
      entries: [],
      clientEvalEntryKeys: [],
    } as unknown as Parameters<typeof benchmark.getCustomRouterStatus>[0];
    const paid = { ownerType: 'org', ownerId: 'org-1', routerId: 'router-1' } as const;

    const calls: (() => Promise<unknown>)[] = [
      () => admin.getAutoRoutingClassifierModel(),
      () => admin.updateAutoRoutingClassifierModel(null),
      () => admin.getAutoRoutingClassifierAnalytics('7d'),
      () => admin.getAutoRoutingMode({ ownerType: 'user', ownerId: 'user-1' } as never),
      () => admin.updateAutoRoutingMode({ ownerType: 'user', ownerId: 'user-1' } as never),
      () => benchmark.getBenchmarkConfig('efficient'),
      () => benchmark.updateBenchmarkConfig({ router: 'efficient' } as never, 'a@kilocode.ai'),
      () => benchmark.getBenchmarkSchedulerConfig(),
      () => benchmark.updateBenchmarkSchedulerConfig({}, 'a@kilocode.ai'),
      () => benchmark.listBenchmarkRuns(),
      () => benchmark.getBenchmarkRunSummaries('run-1'),
      () => benchmark.startBenchmarkRun('classifier', false, 'all' as never),
      () => benchmark.getBenchmarkRegistry(),
      () => benchmark.requeueBenchmarkRegistry('all' as never),
      () => benchmark.readmitBenchmarkProfile({ model: 'm', provider: 'p' } as never),
      () => benchmark.getBenchmarkRoutingTable('efficient'),
      () =>
        benchmark.registerOwnerBenchmarkProfiles({
          router: 'efficient',
          ownerType: 'org',
          ownerId: 'org-1',
          entries: [],
        }),
      () => benchmark.getCustomRouterStatus(context),
      () => benchmark.getCustomRouterTable(context),
      () => benchmark.lookupCustomRouterBlockedModels({} as never).catch(() => null),
      () => benchmark.requestPaidBenchmarkQuote({ action: 'quote', ...paid } as never),
      () => benchmark.startPaidBenchmark({ action: 'start', ...paid } as never),
      () => benchmark.getPaidBenchmarkProgress({ action: 'progress', ...paid } as never),
      () => benchmark.pausePaidBenchmark({ action: 'pause', ...paid } as never),
      () => benchmark.pausePoolBenchmark(paid),
      () => benchmark.getPlatformMeasurements('efficient'),
      () => benchmark.cancelBenchmarkRun('run-1'),
      () => benchmark.listPaidBenchmarkAdminRequests({ router: 'efficient' }),
      () => benchmark.getPaidBenchmarkAdminProgress('request-1'),
      () => benchmark.pausePaidBenchmarkAdminRequest('request-1'),
      () => benchmark.getPaidBenchmarkAdminRoutingTable('request-1'),
      () => benchmark.acquireAliasPromotion({ action: 'acquire' } as never),
      () => benchmark.releaseAliasPromotion({ action: 'release' } as never),
    ];
    for (const call of calls) await call();

    expect(named).toHaveLength(calls.length);
    for (const { method, url, route } of named) {
      expect({ method, path: url.pathname, route }).toEqual({
        method,
        path: url.pathname,
        route: governedRoute(method, url),
      });
    }
  });
});

describe('a process without an installed sender', () => {
  it('sends the internal secret while every switch is legacy or unset', async () => {
    mockSwitches.AUTO_ROUTING_ADMIN_SENDER_AUTH = 'legacy';
    const { benchmark, decision } = await loadClients();
    await benchmark.getBenchmarkConfig('efficient');
    await decision.fetchEfficientAutoDecision(decideParams, { onError: () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer legacy-internal-secret'
      );
    }
  });

  it.each([
    'AUTO_ROUTING_DECIDE_SENDER_AUTH',
    'GATEWAY_ROUTING_TABLES_SENDER_AUTH',
    'AUTO_ROUTING_ADMIN_SENDER_AUTH',
    'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
    'WEB_ROUTING_TABLES_SENDER_AUTH',
  ])('sends nothing, and logs once, while %s is sts', async variable => {
    mockSwitches[variable] = 'sts';
    const { admin, benchmark, decision } = await loadClients();

    await expect(benchmark.getBenchmarkConfig('efficient')).resolves.toMatchObject({
      status: 500,
    });
    await expect(admin.getAutoRoutingClassifierModel()).resolves.toMatchObject({ status: 500 });
    await expect(
      decision.fetchEfficientAutoDecision(decideParams, { onError: () => {} })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('the clients without a token', () => {
  const tokenUnavailable = senderAnswering({ kind: 'unavailable', reason: 'token_unavailable' });

  it('answers an admin call 503 and sends nothing', async () => {
    const { benchmark, adminFetch } = await loadClients(tokenUnavailable);

    await expect(benchmark.getBenchmarkConfig('efficient')).resolves.toEqual({
      status: 503,
      body: { error: adminFetch.WORKER_TOKEN_UNAVAILABLE_ERROR },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 504 when its own deadline ended the wait for a token', async () => {
    jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('spent', 'TimeoutError')));
    const { benchmark } = await loadClients(tokenUnavailable);

    await expect(benchmark.getBenchmarkConfig('efficient')).resolves.toEqual({
      status: 504,
      body: { error: 'Worker request timed out' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws the caller's abort when the caller's signal ended the wait", async () => {
    const { benchmark } = await loadClients(tokenUnavailable);
    const controller = new AbortController();
    const reason = new DOMException('caller left', 'AbortError');
    controller.abort(reason);

    await expect(benchmark.getBenchmarkRoutingTable('efficient', controller.signal)).rejects.toBe(
      reason
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 500 for a refused configuration', async () => {
    const { benchmark } = await loadClients(
      senderAnswering({ kind: 'unavailable', reason: 'misconfigured' })
    );

    await expect(benchmark.getBenchmarkConfig('efficient')).resolves.toEqual({
      status: 500,
      body: { error: 'Auto routing benchmark worker is not configured' },
    });
  });

  it('answers a paid request 503 token_unavailable, or 504 timeout past its deadline', async () => {
    const paid = { action: 'quote', ownerType: 'org', ownerId: 'org-1', routerId: 'r' } as never;
    const fresh = await loadClients(tokenUnavailable);

    await expect(fresh.benchmark.requestPaidBenchmarkQuote(paid)).resolves.toEqual({
      ok: false,
      status: 503,
      error: {
        code: 'token_unavailable',
        message: fresh.adminFetch.WORKER_TOKEN_UNAVAILABLE_ERROR,
      },
    });

    jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('spent', 'TimeoutError')));
    const spent = await loadClients(tokenUnavailable);
    await expect(spent.benchmark.requestPaidBenchmarkQuote(paid)).resolves.toMatchObject({
      ok: false,
      status: 504,
      error: { code: 'timeout' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a profile registration 503, or throws past its deadline', async () => {
    const request = {
      router: 'efficient',
      ownerType: 'org',
      ownerId: 'org-1',
      entries: [],
    } as const;
    const { benchmark, adminFetch } = await loadClients(tokenUnavailable);

    await expect(
      benchmark.registerOwnerBenchmarkProfiles(request, new AbortController().signal)
    ).resolves.toEqual({
      ok: false,
      status: 503,
      error: { error: adminFetch.WORKER_TOKEN_UNAVAILABLE_ERROR },
    });
    const spent = AbortSignal.abort(new DOMException('spent', 'TimeoutError'));
    await expect(benchmark.registerOwnerBenchmarkProfiles(request, spent)).rejects.toBe(
      spent.reason
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the decide worker uncalled and reports a failure reason once', async () => {
    const onError = jest.fn();
    const { decision } = await loadClients(tokenUnavailable);

    await expect(decision.fetchEfficientAutoDecision(decideParams, { onError })).resolves.toBeNull();
    await expect(
      decision.fetchCustomRouterDecision(
        { ...decideParams, customRouter: { ownerType: 'org', slug: 'team' } as never },
        { onError }
      )
    ).resolves.toEqual({ kind: 'unavailable' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Efficient auto decision credential unavailable', {
      error: 'token_unavailable',
    });
  });
});
