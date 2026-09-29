import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/code-reviews/telemetry/review-health-aggregate', () => ({
  collectCodeReviewOutcome: jest.fn(),
  collectCodeReviewOpenStock: jest.fn(),
}));

import {
  collectCodeReviewOpenStock,
  collectCodeReviewOutcome,
} from '@/lib/code-reviews/telemetry/review-health-aggregate';
import { GET } from './route';

const outcomeMock = jest.mocked(collectCodeReviewOutcome);
const openStockMock = jest.mocked(collectCodeReviewOpenStock);

const request = (authorization?: string) =>
  new NextRequest('http://localhost:3000/api/cron/code-review-outcome-aggregate', {
    method: 'GET',
    headers: authorization ? { authorization } : undefined,
  });

describe('GET /api/cron/code-review-outcome-aggregate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    outcomeMock.mockResolvedValue('complete');
    openStockMock.mockResolvedValue('complete');
  });

  it('returns 401 without collecting when authorization is missing', async () => {
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(outcomeMock).not.toHaveBeenCalled();
    expect(openStockMock).not.toHaveBeenCalled();
  });

  it('returns 401 without collecting when authorization is wrong', async () => {
    const response = await GET(request('Bearer wrong-secret'));

    expect(response.status).toBe(401);
    expect(outcomeMock).not.toHaveBeenCalled();
    expect(openStockMock).not.toHaveBeenCalled();
  });

  it('collects the outcome then the open stock and returns only collectionStatus', async () => {
    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ collectionStatus: 'complete' });
    expect(outcomeMock).toHaveBeenCalledTimes(1);
    expect(openStockMock).toHaveBeenCalledTimes(1);
    expect(outcomeMock.mock.invocationCallOrder[0]).toBeLessThan(
      openStockMock.mock.invocationCallOrder[0]
    );
  });

  it('reports failed when either collection fails', async () => {
    outcomeMock.mockResolvedValue('failed');

    const response = await GET(request('Bearer cron-secret'));

    await expect(response.json()).resolves.toEqual({ collectionStatus: 'failed' });
  });
});

describe('route module without CRON_SECRET', () => {
  it('imports and returns 401 without collecting', async () => {
    jest.resetModules();
    jest.doMock('@/lib/config.server', () => ({ CRON_SECRET: '' }));
    jest.doMock('@/lib/code-reviews/telemetry/review-health-aggregate', () => ({
      collectCodeReviewOutcome: jest.fn(),
      collectCodeReviewOpenStock: jest.fn(),
    }));

    const { GET: isolatedGet } = (await import('./route')) as { GET: typeof GET };
    const response = await isolatedGet(request('Bearer anything'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });
});
