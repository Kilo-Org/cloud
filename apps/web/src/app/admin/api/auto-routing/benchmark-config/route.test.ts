import { NextRequest } from 'next/server';
import type { User } from '@kilocode/db';
import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkConfig: jest.fn(),
  updateBenchmarkConfig: jest.fn(),
}));

import { GET, PUT } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetBenchmarkConfig = jest.mocked(getBenchmarkConfig);
const mockUpdateBenchmarkConfig = jest.mocked(updateBenchmarkConfig);

// Test-fixture boundary: only the fields the route actually reads.
function adminUserFixture(): User {
  return { id: 'admin_123', google_user_email: 'admin@kilocode.ai' } as Partial<User> as User;
}

function putRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/admin/api/auto-routing/benchmark-config', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const validConfig = {
  router: 'efficient' as const,
  accuracyNoiseBand: 0.05,
  frontierMinAccuracyDelta: 0,
  classifierModels: ['google/gemini-2.5-flash-lite'],
  deciderModels: [{ id: 'openai/gpt-5-mini' }],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  lowConfidenceThreshold: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: 1000,
  updatedAt: null,
  updatedBy: null,
};

describe('PUT /admin/api/auto-routing/benchmark-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: adminUserFixture(),
      authFailedResponse: null,
    });
    mockUpdateBenchmarkConfig.mockResolvedValue({
      status: 200,
      body: { config: validConfig },
    });
    mockGetBenchmarkConfig.mockResolvedValue({ status: 200, body: { config: null } });
  });

  it('defaults config reads to efficient', async () => {
    await GET();
    expect(mockGetBenchmarkConfig).toHaveBeenCalledWith('efficient');
  });

  it('forwards frontier config reads', async () => {
    await GET(
      new NextRequest(
        'http://localhost:3000/admin/api/auto-routing/benchmark-config?router=frontier'
      )
    );
    expect(mockGetBenchmarkConfig).toHaveBeenCalledWith('frontier');
  });

  it('rejects an unknown router before proxying', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/admin/api/auto-routing/benchmark-config?router=unknown'
      )
    );
    expect(response.status).toBe(400);
    expect(mockGetBenchmarkConfig).not.toHaveBeenCalled();
  });

  it('forwards frontier config updates and accuracy settings', async () => {
    await PUT(
      putRequest({
        ...validConfig,
        router: 'frontier',
        accuracyNoiseBand: 0.02,
        frontierMinAccuracyDelta: 0,
      })
    );
    expect(mockUpdateBenchmarkConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        router: 'frontier',
        accuracyNoiseBand: 0.02,
        frontierMinAccuracyDelta: 0,
      }),
      'admin@kilocode.ai'
    );
  });

  it('rejects a schema-invalid config with 400', async () => {
    const response = await PUT(putRequest({ classifierModels: 'oops' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid benchmark config' });
    expect(mockUpdateBenchmarkConfig).not.toHaveBeenCalled();
  });
});
