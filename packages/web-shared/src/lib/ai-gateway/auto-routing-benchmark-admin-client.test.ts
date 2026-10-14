import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
  listBenchmarkRuns,
  startBenchmarkRun,
  getBenchmarkRoutingTable,
  getBenchmarkRegistry,
  requeueBenchmarkRegistry,
} from './auto-routing-benchmark-admin-client';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://benchmark-worker.example.com',
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const configResponse = {
  config: {
    router: 'efficient' as const,
    accuracyNoiseBand: 0.05,
    frontierMinAccuracyDelta: 0,
    classifierModels: ['anthropic/claude-haiku-4'],
    deciderModels: [{ id: 'anthropic/claude-sonnet-4' }],
    minAccuracy: 0.8,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    productionTokenProfile: null,
    switchHorizonTurns: null,
    lowConfidenceThreshold: null,
    maxConcurrency: 4,
    userMaxConcurrency: 100,
    benchmarkUserId: null,
    benchmarkOrgId: null,
    classifierRepetitions: 1,
    deciderRepetitions: 1,
    classifierMaxP95LatencyMs: 1000,
    autoDeciderMinCostUsd: 15,
    autoDeciderMaxCostUsd: 25,
    updatedAt: null,
    updatedBy: null,
  },
};

const runsResponse = {
  runs: [
    {
      id: 'run-1',
      router: 'efficient',
      kind: 'classifier',
      purpose: 'platform',
      status: 'completed',
      startedAt: '2026-06-01T00:00:00Z',
      completedAt: '2026-06-01T01:00:00Z',
      error: null,
      summaries: [],
    },
  ],
};

describe('auto routing benchmark admin client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('propagates error body when upstream responds with a non-OK status', async () => {
    mockFetch.mockResolvedValue({
      status: 404,
      ok: false,
      json: () => Promise.resolve({ error: 'not found' }),
    });

    await expect(getBenchmarkConfig()).resolves.toEqual({
      status: 404,
      body: { error: 'not found' },
    });
  });

  it('updates the benchmark config and sends x-updated-by header', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(configResponse),
    });

    await updateBenchmarkConfig(configResponse.config, 'admin@kilocode.ai');

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/config?router=efficient', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test-internal-secret',
        'content-type': 'application/json',
        'x-updated-by': 'admin@kilocode.ai',
      },
      body: JSON.stringify(configResponse.config),
    });
  });

  it('lists benchmark runs', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(runsResponse),
    });

    await expect(listBenchmarkRuns()).resolves.toEqual({
      status: 200,
      body: runsResponse,
    });

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/runs?router=efficient', {
      method: 'GET',
      headers: {
        authorization: 'Bearer test-internal-secret',
      },
    });
  });

  it('propagates error body from listBenchmarkRuns on non-OK status', async () => {
    mockFetch.mockResolvedValue({
      status: 401,
      ok: false,
      json: () => Promise.resolve({ error: 'unauthorized' }),
    });

    await expect(listBenchmarkRuns()).resolves.toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
  });

  it('starts a benchmark run with the given kind, force flag and queue', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ runId: 'run-2', enqueuedModels: 3, skippedModels: [] }),
    });

    await expect(startBenchmarkRun('classifier', false, 'platform')).resolves.toEqual({
      status: 200,
      body: {
        runId: 'run-2',
        enqueuedModels: 3,
        skippedModels: [],
        startedRuns: [],
        drainErrors: [],
      },
    });

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/runs?router=efficient', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'classifier', force: false, queue: 'platform', router: 'efficient' }),
    });
  });

  it('starts a run for both registry queues', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          runId: 'decider-1',
          enqueuedModels: 5,
          skippedModels: [],
          startedRuns: [
            { runId: 'decider-1', purpose: 'platform', entryCount: 2 },
            { runId: 'user-1', purpose: 'user', entryCount: 3 },
          ],
        }),
    });

    const result = await startBenchmarkRun('decider', false, 'both');

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/runs?router=efficient', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'decider', force: false, queue: 'both', router: 'efficient' }),
    });
    expect(result.body).toMatchObject({
      startedRuns: [
        { runId: 'decider-1', purpose: 'platform', entryCount: 2 },
        { runId: 'user-1', purpose: 'user', entryCount: 3 },
      ],
    });
  });

  it('gets the benchmark routing table', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ table: null, publishedAt: null }),
    });

    await expect(getBenchmarkRoutingTable()).resolves.toEqual({
      status: 200,
      body: { table: null, publishedAt: null },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://benchmark-worker.example.com/admin/routing-table?router=efficient',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-internal-secret',
        },
      }
    );
  });

  it('passes frontier on every selectable endpoint', async () => {
    mockFetch.mockResolvedValue({
      status: 404, ok: false, json: () => Promise.resolve({ error: 'not configured' }),
    });
    await getBenchmarkConfig('frontier');
    await updateBenchmarkConfig({ ...configResponse.config, router: 'frontier' }, 'admin@kilocode.ai');
    await listBenchmarkRuns({ router: 'frontier' });
    await startBenchmarkRun('decider', false, 'platform', 'frontier');
    await getBenchmarkRegistry('frontier');
    await requeueBenchmarkRegistry('platform', 'frontier');
    await getBenchmarkRoutingTable('frontier');
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://benchmark-worker.example.com/admin/config?router=frontier',
      'https://benchmark-worker.example.com/admin/config?router=frontier',
      'https://benchmark-worker.example.com/admin/runs?router=frontier',
      'https://benchmark-worker.example.com/admin/runs?router=frontier',
      'https://benchmark-worker.example.com/admin/registry?router=frontier',
      'https://benchmark-worker.example.com/admin/registry/requeue?router=frontier',
      'https://benchmark-worker.example.com/admin/routing-table?router=frontier',
    ]);
  });
});
