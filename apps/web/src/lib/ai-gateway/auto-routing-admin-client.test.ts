import {
  getAutoRoutingClassifierAnalytics,
  getAutoRoutingClassifierModel,
  updateAutoRoutingClassifierModel,
} from './auto-routing-admin-client';

jest.mock('@/lib/config.server', () => ({
  AUTO_ROUTING_WORKER_URL: 'https://auto-routing.example.com',
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const classifierModelResponse = {
  model: 'google/gemma-4-31b-it',
  defaultModel: 'google/gemma-4-31b-it',
};

const classifierAnalyticsResponse = {
  period: '7d',
  summary: {
    totalRequests: 0,
    classifiedRequests: 0,
    classifierErrors: 0,
    invalidRequests: 0,
    totalCostCredits: 0,
    avgDurationMs: 0,
    p95DurationMs: 0,
    avgConfidence: 0,
    withSessionId: 0,
    uniqueSessions: 0,
    requiresTools: 0,
    mirroredHasTools: 0,
    avgBodyBytes: 0,
  },
  statusBreakdown: [],
  taskTypeBreakdown: [],
  classifierModelBreakdown: [],
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

    await updateAutoRoutingClassifierModel('google/gemma-4-31b-it');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auto-routing.example.com/admin/classifier-model',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer test-internal-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'google/gemma-4-31b-it' }),
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
});
