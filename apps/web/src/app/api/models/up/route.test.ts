import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: (name: string) => `test-${name}`,
  requireEnv: (name: string) => `test-${name}`,
}));

let mockHealthSecret = 'test-models-monitor-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/config.server'),
  get MODELS_HEALTH_SECRET() {
    return mockHealthSecret;
  },
}));

let mockMonitoredModelsError: Error | null = null;

jest.mock('@kilocode/web-shared/lib/ai-gateway/preferred-models', () => ({
  getMonitoredModels: async () => {
    if (mockMonitoredModelsError) throw mockMonitoredModelsError;
    return ['poolside/laguna-s-2.1:free', 'minimax/minimax-m3', 'minimax/minimax-m3:free'];
  },
}));

import { captureException } from '@sentry/nextjs';
import { GET } from './route';

function makeRequest(token: string | null = 'test-models-monitor-secret', query = '') {
  return new NextRequest(`http://localhost:3000/api/models/up${query}`, {
    method: 'GET',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}

function analyticsEngineResponse(data: unknown[]) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET /api/models/up', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    mockHealthSecret = 'test-models-monitor-secret';
    mockMonitoredModelsError = null;
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      analyticsEngineResponse([
        {
          model: 'poolside/laguna-s-2.1',
          bucket: 'current',
          requests: 120,
          unique_users: 40,
        },
        {
          model: 'minimax/minimax-m3',
          bucket: 'current',
          requests: 80,
          unique_users: 30,
        },
      ])
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reports monitored models under their normalized Analytics Engine IDs', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(Object.keys(body.models).sort()).toEqual([
      'minimax/minimax-m3',
      'poolside/laguna-s-2.1',
    ]);
    expect(body.models['poolside/laguna-s-2.1']).toMatchObject({
      healthy: true,
      currentRequests: 120,
      uniqueUsersCurrent: 40,
    });
    expect(body.models['minimax/minimax-m3']).toMatchObject({
      healthy: true,
      currentRequests: 80,
    });
  });

  it('fails closed without querying when the monitored model list is unavailable', async () => {
    const error = new Error('No monitored models');
    mockMonitoredModelsError = error;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ healthy: false, error: 'No monitored models' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(error, expect.anything());
    consoleError.mockRestore();
  });

  it('queries each normalized model ID once', async () => {
    await GET(makeRequest());

    const query = String(fetchSpy.mock.calls[0][1].body);
    expect(query).toContain("blob2 IN ('poolside/laguna-s-2.1', 'minimax/minimax-m3')");
  });

  describe('credential handling', () => {
    it('rejects a request without an authorization header', async () => {
      const response = await GET(makeRequest(null));

      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ healthy: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a request with the wrong bearer token', async () => {
      const response = await GET(makeRequest('not-the-monitor-secret'));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ healthy: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects every caller when no secret is configured', async () => {
      mockHealthSecret = '';

      const response = await GET(makeRequest('any-presented-token'));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ healthy: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('ignores a credential supplied as a query parameter', async () => {
      const response = await GET(makeRequest(null, '?key=test-models-monitor-secret'));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ healthy: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps the anchored window for an authorized caller', async () => {
      const anchor = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const response = await GET(makeRequest(undefined, `?at=${encodeURIComponent(anchor)}`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.metadata.timestamp).toBe(anchor);
    });
  });
});
