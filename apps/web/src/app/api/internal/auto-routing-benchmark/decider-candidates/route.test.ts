import { NextRequest } from 'next/server';
import { listAutoRoutingDeciderCandidates } from '@/lib/model-stats/auto-routing-decider-candidates';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
}));

jest.mock('@/lib/model-stats/auto-routing-decider-candidates', () => ({
  AUTO_DECIDER_MIN_COST_USD: 15,
  AUTO_DECIDER_MAX_COST_USD: 25,
  listAutoRoutingDeciderCandidates: jest.fn(),
}));

import { GET } from './route';

const mockListAutoRoutingDeciderCandidates = jest.mocked(listAutoRoutingDeciderCandidates);

function createRequest(headers: Record<string, string> = {}) {
  return new NextRequest(
    'http://localhost:3000/api/internal/auto-routing-benchmark/decider-candidates',
    { headers }
  );
}

function createRequestWithBounds(headers: Record<string, string> = {}) {
  return new NextRequest(
    'http://localhost:3000/api/internal/auto-routing-benchmark/decider-candidates?minCostUsd=12&maxCostUsd=24',
    { headers }
  );
}

describe('GET /api/internal/auto-routing-benchmark/decider-candidates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAutoRoutingDeciderCandidates.mockResolvedValue([
      { id: 'model/a', avgAttemptCostUsd: 20.5 },
    ]);
  });

  it('returns 401 without the bearer secret', async () => {
    const res = await GET(createRequest());

    expect(res.status).toBe(401);
    expect(mockListAutoRoutingDeciderCandidates).not.toHaveBeenCalled();
  });

  it('returns synced auto decider candidates for authenticated worker callers', async () => {
    const res = await GET(createRequest({ authorization: 'Bearer internal-secret' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      candidates: [{ id: 'model/a', avgAttemptCostUsd: 20.5 }],
      minCostUsd: 15,
      maxCostUsd: 25,
    });
  });

  it('uses requested cost bounds for authenticated worker callers', async () => {
    const res = await GET(createRequestWithBounds({ authorization: 'Bearer internal-secret' }));

    expect(res.status).toBe(200);
    expect(mockListAutoRoutingDeciderCandidates).toHaveBeenCalledWith({
      minCostUsd: 12,
      maxCostUsd: 24,
    });
    await expect(res.json()).resolves.toMatchObject({
      minCostUsd: 12,
      maxCostUsd: 24,
    });
  });
});
