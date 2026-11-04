import {
  getAutoRoutingClassifierAnalytics,
  getAutoRoutingClassifierModel,
  getAutoRoutingMode,
  updateAutoRoutingClassifierModel,
  updateAutoRoutingMode,
} from './auto-routing-admin-client';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
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
});

describe('platform routing mode admin client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(['user', 'org'] as const)(
    'reads saved %s modes through the mode-only endpoint',
    async ownerType => {
      const owner = { ownerType, ownerId: 'owner/with spaces' };
      const body = {
        ...owner,
        mode: 'best_accuracy',
        configuredMode: 'best_accuracy',
        defaultMode: 'cost_per_accuracy',
      };
      mockFetch.mockResolvedValue(Response.json(body));

      await expect(getAutoRoutingMode(owner)).resolves.toEqual({ status: 200, body });
      expect(mockFetch).toHaveBeenCalledWith(
        `https://auto-routing.example.com/admin/routing-mode?${new URLSearchParams(owner)}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${INTERNAL_API_SECRET}` },
        }
      );
    }
  );

  it.each(['cost_per_accuracy', 'best_accuracy', null] as const)(
    'writes mode %s without sending pool settings',
    async mode => {
      const owner = { ownerType: 'org' as const, ownerId: 'org-1' };
      const body = {
        ...owner,
        mode: mode ?? 'cost_per_accuracy',
        configuredMode: mode,
        defaultMode: 'cost_per_accuracy',
      };
      mockFetch.mockResolvedValue(Response.json(body));

      await expect(updateAutoRoutingMode({ ...owner, mode })).resolves.toEqual({
        status: 200,
        body,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://auto-routing.example.com/admin/routing-mode',
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${INTERNAL_API_SECRET}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...owner, mode }),
        }
      );
    }
  );

  it('preserves worker failures instead of reporting an unsaved mode as saved', async () => {
    mockFetch.mockResolvedValue(
      Response.json({ error: 'Mode storage unavailable' }, { status: 503 })
    );
    await expect(
      updateAutoRoutingMode({ ownerType: 'user', ownerId: 'user-1', mode: null })
    ).resolves.toEqual({ status: 503, body: { error: 'Mode storage unavailable' } });
  });

  it('rejects an invalid successful worker mode response', async () => {
    mockFetch.mockResolvedValue(
      Response.json({
        ownerType: 'user',
        ownerId: 'user-1',
        mode: 'best_accuracy',
        defaultMode: 'cost_per_accuracy',
      })
    );
    await expect(getAutoRoutingMode({ ownerType: 'user', ownerId: 'user-1' })).rejects.toThrow();
  });
});
