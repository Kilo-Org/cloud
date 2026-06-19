import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
  listBenchmarkRuns,
  startBenchmarkRun,
  getBenchmarkRoutingTable,
} from './auto-routing-benchmark-admin-client';

jest.mock('@/lib/config.server', () => ({
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://benchmark-worker.example.com',
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const configResponse = {
  config: {
    classifierModels: ['anthropic/claude-haiku-4'],
    deciderModels: [{ id: 'anthropic/claude-sonnet-4', reasoningEffort: null }],
    minAccuracy: 0.8,
    switchCostFactor: 3,
    maxConcurrency: 4,
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
      kind: 'classifier',
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

  it('gets the benchmark config and sends bearer auth header', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(configResponse),
    });

    await expect(getBenchmarkConfig()).resolves.toEqual({
      status: 200,
      body: configResponse,
    });

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/config', {
      method: 'GET',
      headers: {
        authorization: 'Bearer test-internal-secret',
      },
    });
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

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/config', {
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

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/runs', {
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

  it('starts a benchmark run with the given kind and force flag', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ runId: 'run-2', enqueuedModels: 3, skippedModels: [] }),
    });

    await expect(startBenchmarkRun('classifier', false)).resolves.toEqual({
      status: 200,
      body: { runId: 'run-2', enqueuedModels: 3, skippedModels: [] },
    });

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'classifier', force: false }),
    });
  });

  it('starts a benchmark run with force=true to re-run existing models', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({ runId: 'run-3', enqueuedModels: 3, skippedModels: ['model-a'] }),
    });

    await startBenchmarkRun('decider', true);

    expect(mockFetch).toHaveBeenCalledWith('https://benchmark-worker.example.com/admin/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'decider', force: true }),
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
      'https://benchmark-worker.example.com/admin/routing-table',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-internal-secret',
        },
      }
    );
  });
});
