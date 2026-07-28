import {
  getAutoRoutingClassifierAnalytics,
  getAutoRoutingClassifierModel,
  getAutoRoutingSettings,
  updateAutoRoutingClassifierModel,
  updateAutoRoutingSettings,
} from './auto-routing-admin-client';

jest.mock('@/lib/config.server', () => ({
  AUTO_ROUTING_WORKER_URL: 'https://auto-routing.example.com',
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const classifierModelResponse = {
  model: 'google/gemini-2.5-flash-lite',
  override: null,
  benchmarkWinner: null,
  defaultModel: 'google/gemini-2.5-flash-lite',
};

const classifierAnalyticsResponse = {
  period: '7d',
  summary: {
    totalRequests: 0,
    classifiedRequests: 0,
    cachedRequests: 0,
    fallbackRequests: 0,
    classifierErrors: 0,
    invalidRequests: 0,
    totalCostCredits: 0,
    avgDurationMs: 0,
    p95DurationMs: 0,
  },
  statusBreakdown: [],
  taskTypeBreakdown: [],
  taskSubtypeBreakdown: [],
  classifierModelBreakdown: [],
};

const settingsResponse = {
  ownerType: 'user',
  ownerId: 'user-1',
  mode: 'cost_per_accuracy',
  configuredMode: null,
  defaultMode: 'cost_per_accuracy',
  configuredPool: [{ model: 'google/gemini-2.5-flash', variant: null }],
  poolStatuses: [
    {
      entry: { model: 'google/gemini-2.5-flash', variant: null },
      status: 'ready',
    },
  ],
};

describe('auto routing admin client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('gets the classifier model using worker bearer auth', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(classifierModelResponse),
    });

    await expect(getAutoRoutingClassifierModel()).resolves.toEqual({
      status: 200,
      body: classifierModelResponse,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/classifier-model',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-internal-secret',
        },
      }
    );
  });

  it('updates the classifier model through the worker', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(classifierModelResponse),
    });

    await updateAutoRoutingClassifierModel('google/gemini-2.5-flash-lite');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/classifier-model',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer test-internal-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite' }),
      }
    );
  });

  it('clears the classifier model override by sending null', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(classifierModelResponse),
    });

    await updateAutoRoutingClassifierModel(null);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/classifier-model',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer test-internal-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: null }),
      }
    );
  });

  it('queries classifier analytics for the selected period', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(classifierAnalyticsResponse),
    });

    await getAutoRoutingClassifierAnalytics('7d');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/classifier-analytics?period=7d',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-internal-secret',
        },
      }
    );
  });

  it('gets routing settings using worker bearer auth', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(settingsResponse),
    });

    await expect(getAutoRoutingSettings({ ownerType: 'user', ownerId: 'user-1' })).resolves.toEqual(
      {
        status: 200,
        body: settingsResponse,
      }
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/routing-settings?ownerType=user&ownerId=user-1',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer test-internal-secret',
        },
      }
    );
  });

  it('updates routing settings and forwards optional retryEntries', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(settingsResponse),
    });

    await updateAutoRoutingSettings({
      ownerType: 'org',
      ownerId: 'org-1',
      mode: 'best_accuracy',
      pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
      retryEntries: [{ model: 'google/gemini-2.5-flash', variant: null }],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/routing-settings',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer test-internal-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ownerType: 'org',
          ownerId: 'org-1',
          mode: 'best_accuracy',
          pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
          retryEntries: [{ model: 'google/gemini-2.5-flash', variant: null }],
        }),
      }
    );
  });

  it('preserves benchmark quota 429 bodies including retryAt', async () => {
    const quotaBody = {
      error: 'Benchmark profile request limit exceeded',
      retryAt: '2026-07-29T12:00:00.000Z',
    };
    mockFetch.mockResolvedValue({
      status: 429,
      ok: false,
      json: () => Promise.resolve(quotaBody),
    });

    await expect(
      updateAutoRoutingSettings({
        ownerType: 'user',
        ownerId: 'user-1',
        mode: null,
        pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
      })
    ).resolves.toEqual({
      status: 429,
      body: quotaBody,
    });
  });

  it('returns 502 for 2xx bodies that fail settings schema validation', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ unexpected: true }),
    });

    await expect(getAutoRoutingSettings({ ownerType: 'user', ownerId: 'user-1' })).resolves.toEqual(
      {
        status: 502,
        body: { error: 'Invalid worker settings response' },
      }
    );
  });

  it('returns 502 for 2xx non-JSON bodies without throwing', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    });

    await expect(
      updateAutoRoutingSettings({
        ownerType: 'user',
        ownerId: 'user-1',
        mode: null,
        pool: null,
      })
    ).resolves.toEqual({
      status: 502,
      body: { error: 'Invalid worker settings response' },
    });
  });

  it('passes through non-2xx worker error bodies', async () => {
    mockFetch.mockResolvedValue({
      status: 404,
      ok: false,
      json: () => Promise.resolve({ error: 'Settings not found' }),
    });

    await expect(getAutoRoutingSettings({ ownerType: 'user', ownerId: 'user-1' })).resolves.toEqual(
      {
        status: 404,
        body: { error: 'Settings not found' },
      }
    );
  });
});
