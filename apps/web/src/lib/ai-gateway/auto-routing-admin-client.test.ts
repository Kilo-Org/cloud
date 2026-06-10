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

describe('auto routing admin client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  it('gets the classifier model using worker bearer auth', async () => {
    await expect(getAutoRoutingClassifierModel()).resolves.toEqual({
      status: 200,
      body: { ok: true },
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
