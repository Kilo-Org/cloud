import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as codeReviewsDbModule from '@/lib/code-reviews/db/code-reviews';
import type * as routeModule from './route';
import type { CloudAgentCodeReview } from '@kilocode/db/schema';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

// The route is imported after the module mocks are in place, so it binds the
// mocked db module rather than the real one.
let POST: typeof routeModule.POST;

const mockGetCodeReviewById = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.getCodeReviewById
>;
const mockSettleCodeReviewUsage = jest.fn() as jest.MockedFunction<
  typeof codeReviewsDbModule.settleCodeReviewUsage
>;
const mockCaptureException = jest.fn();

jest.mock('@/lib/internal-api-auth', () => ({
  authorizeInternalApiRequest: () => null,
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => ({
  getCodeReviewById: mockGetCodeReviewById,
  settleCodeReviewUsage: mockSettleCodeReviewUsage,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

function request(body: string | object, reviewId = REVIEW_ID) {
  return new NextRequest(`http://localhost/api/internal/code-review-usage/${reviewId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function post(body: string | object, reviewId = REVIEW_ID) {
  return POST(request(body, reviewId), {
    params: Promise.resolve({ reviewId }),
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetCodeReviewById.mockResolvedValue({ id: REVIEW_ID } as CloudAgentCodeReview);
  mockSettleCodeReviewUsage.mockResolvedValue(true);
  ({ POST } = await import('./route'));
});

describe('POST /api/internal/code-review-usage/[reviewId]', () => {
  it('stores the payload on the review, converting the cost to microdollars', async () => {
    const response = await post({
      model: 'anthropic/claude-sonnet-4.6',
      totalTokensIn: 1200,
      totalTokensOut: 340,
      totalCost: 0.05678,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockSettleCodeReviewUsage).toHaveBeenCalledWith(REVIEW_ID, {
      model: 'anthropic/claude-sonnet-4.6',
      totalTokensIn: 1200,
      totalTokensOut: 340,
      totalCostMusd: 56780,
    });
  });

  it('succeeds without changing stored usage when the review already recorded it', async () => {
    mockSettleCodeReviewUsage.mockResolvedValue(false);

    const response = await post({
      model: 'openai/gpt-5',
      totalTokensIn: 1,
      totalTokensOut: 1,
      totalCost: 0.000001,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockSettleCodeReviewUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['input tokens above the per-review maximum', { totalTokensIn: 200_000_001 }],
    ['output tokens above the per-review maximum', { totalTokensOut: 50_000_001 }],
    ['cost above the per-review maximum', { totalCost: 2_000.01 }],
    ['negative input tokens', { totalTokensIn: -1 }],
    ['fractional input tokens', { totalTokensIn: 1.5 }],
    ['a model name above the maximum length', { model: 'm'.repeat(513) }],
  ])('rejects %s before reading the review', async (_case, payload) => {
    const response = await post(payload);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; details: unknown };
    expect(body.error).toBe('Invalid payload');
    expect(body.details).toBeDefined();
    expect(mockGetCodeReviewById).not.toHaveBeenCalled();
    expect(mockSettleCodeReviewUsage).not.toHaveBeenCalled();
  });

  it('rejects a non-finite cost before reading the review', async () => {
    const response = await post('{"totalCost":1e400}');

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Invalid payload');
    expect(mockGetCodeReviewById).not.toHaveBeenCalled();
    expect(mockSettleCodeReviewUsage).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown review and writes nothing', async () => {
    mockGetCodeReviewById.mockResolvedValue(null);

    const response = await post({ totalTokensIn: 1 });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Review not found' });
    expect(mockSettleCodeReviewUsage).not.toHaveBeenCalled();
  });
});
