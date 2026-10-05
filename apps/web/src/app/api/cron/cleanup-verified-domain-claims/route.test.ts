import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/organizations/verified-domain-cleanup', () => ({
  runVerifiedDomainClaimCleanup: jest.fn(),
}));

import {
  runVerifiedDomainClaimCleanup,
  type VerifiedDomainCleanupReport,
} from '@/lib/organizations/verified-domain-cleanup';
import { GET, maxDuration } from './route';

const mockRun = jest.mocked(runVerifiedDomainClaimCleanup);

function report(overrides: Partial<VerifiedDomainCleanupReport['summary']> = {}) {
  return {
    runId: 'run-1',
    mode: 'dry_run',
    totalCandidates: 0,
    results: [],
    ssoOrganizationsWithClaims: [],
    summary: { planned: 0, completed: 0, failed: 0, aborted: 0, ...overrides },
  } satisfies VerifiedDomainCleanupReport;
}

function request(query = '', authorized = true) {
  return new NextRequest(`http://localhost:3000/api/cron/cleanup-verified-domain-claims${query}`, {
    method: 'GET',
    headers: authorized ? { authorization: 'Bearer cron-secret' } : {},
  });
}

describe('GET /api/cron/cleanup-verified-domain-claims', () => {
  const orgA = '11111111-1111-4111-8111-111111111111';
  const orgB = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    mockRun.mockResolvedValue(report());
  });

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects unauthorized requests without running the cleanup', async () => {
    const response = await GET(request('?execute=true', false));

    expect(response.status).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('defaults to a dry run with a wide limit', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith({ execute: false, limit: 100, organizationIds: [] });
  });

  it('only executes when execute=true and defaults to a small batch', async () => {
    await GET(request('?execute=true'));
    expect(mockRun).toHaveBeenLastCalledWith({ execute: true, limit: 5, organizationIds: [] });

    await GET(request('?execute=yes'));
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('passes repeated organizationId values and an explicit limit', async () => {
    await GET(request(`?execute=true&limit=2&organizationId=${orgA}&organizationId=${orgB}`));

    expect(mockRun).toHaveBeenCalledWith({
      execute: true,
      limit: 2,
      organizationIds: [orgA, orgB],
    });
  });

  it.each(['?organizationId=not-a-uuid', '?limit=0', '?limit=501', '?execute=maybe'])(
    'rejects invalid query %s',
    async query => {
      const response = await GET(request(query));

      expect(response.status).toBe(400);
      expect(mockRun).not.toHaveBeenCalled();
    }
  );

  it('returns HTTP 500 with the report when any organization failed', async () => {
    mockRun.mockResolvedValue(report({ failed: 1 }));

    const response = await GET(request('?execute=true'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ runId: 'run-1' });
  });

  it('returns HTTP 200 when organizations were only aborted', async () => {
    mockRun.mockResolvedValue(report({ aborted: 1 }));

    const response = await GET(request('?execute=true'));

    expect(response.status).toBe(200);
  });
});
