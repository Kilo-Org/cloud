import { NextRequest } from 'next/server';
import type { User } from '@kilocode/db';
import { getBenchmarkRunSummaries } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkRunSummaries: jest.fn(),
}));

import { GET } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetBenchmarkRunSummaries = jest.mocked(getBenchmarkRunSummaries);

// Test-fixture boundary: only the fields the route actually reads.
function adminUserFixture(): User {
  return { id: 'admin_123', google_user_email: 'admin@kilocode.ai' } as Partial<User> as User;
}

function getSummaries(runId: string, query = '') {
  return GET(
    new NextRequest(
      `http://localhost:3000/admin/api/auto-routing/benchmark-runs/${runId}/summaries${query}`
    ),
    { params: Promise.resolve({ runId }) }
  );
}

describe('GET /admin/api/auto-routing/benchmark-runs/[runId]/summaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: adminUserFixture(),
      authFailedResponse: null,
    });
    mockGetBenchmarkRunSummaries.mockResolvedValue({ status: 200, body: { summaries: [] } });
  });

  it('forwards the run id and router to the worker', async () => {
    const response = await getSummaries('decider-1', '?router=frontier');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ summaries: [] });
    expect(mockGetBenchmarkRunSummaries).toHaveBeenCalledWith('decider-1', 'frontier');
  });

  it('passes the worker status through, so a missing run stays a 404', async () => {
    mockGetBenchmarkRunSummaries.mockResolvedValue({
      status: 404,
      body: { error: 'Run not found' },
    });
    const response = await getSummaries('missing');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Run not found' });
    expect(mockGetBenchmarkRunSummaries).toHaveBeenCalledWith('missing', 'efficient');
  });

  it('rejects an unknown router before proxying', async () => {
    const response = await getSummaries('decider-1', '?router=unknown');
    expect(response.status).toBe(400);
    expect(mockGetBenchmarkRunSummaries).not.toHaveBeenCalled();
  });
});
