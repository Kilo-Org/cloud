import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: (name: string) => `test-${name}`,
}));

jest.mock('@/lib/ai-gateway/monitored-models', () => ({
  monitoredModels: ['poolside/laguna-s-2.1:free', 'minimax/minimax-m3', 'minimax/minimax-m3:free'],
}));

import { GET } from './route';

function makeRequest() {
  return new NextRequest('http://localhost:3000/api/models/up?key=kilo-models-health-check', {
    method: 'GET',
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

  it('queries each normalized model ID once', async () => {
    await GET(makeRequest());

    const query = String(fetchSpy.mock.calls[0][1].body);
    expect(query).toContain("blob2 IN ('poolside/laguna-s-2.1', 'minimax/minimax-m3')");
  });
});
