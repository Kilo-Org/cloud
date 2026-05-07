import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as retryModule from '@/lib/code-reviews/sandbox-retry';

const mockClaimAndDispatchCodeReviewSandboxRetries = jest.fn() as jest.MockedFunction<
  typeof retryModule.claimAndDispatchCodeReviewSandboxRetries
>;

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/code-reviews/sandbox-retry', () => ({
  claimAndDispatchCodeReviewSandboxRetries: mockClaimAndDispatchCodeReviewSandboxRetries,
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

function makeRequest(body: Record<string, unknown>, secret = 'test-internal-secret'): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'X-Internal-Secret' ? secret : null) },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

import type { POST as POSTType } from './route';

let POST: typeof POSTType;

beforeEach(async () => {
  jest.clearAllMocks();
  mockClaimAndDispatchCodeReviewSandboxRetries.mockResolvedValue({
    claimed: 0,
    dispatchedOwners: 0,
  });
  ({ POST } = await import('./route'));
});

describe('POST /api/internal/code-review-sandbox-destroyed', () => {
  it('requires internal auth', async () => {
    const response = await POST(
      makeRequest(
        { sandboxId: 'usr-sandbox', phase: 'prepareSession', reason: 'sandbox_500' },
        'bad'
      )
    );

    expect(response.status).toBe(401);
    expect(mockClaimAndDispatchCodeReviewSandboxRetries).not.toHaveBeenCalled();
  });

  it('claims and dispatches retries for a destroyed sandbox notification', async () => {
    mockClaimAndDispatchCodeReviewSandboxRetries.mockResolvedValue({
      claimed: 3,
      dispatchedOwners: 2,
    });

    const response = await POST(
      makeRequest({
        sandboxId: 'usr-sandbox',
        phase: 'prepareSession',
        reason: 'sandbox_500',
        destroyedAt: '2026-05-07T12:00:00.000Z',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ claimed: 3, dispatchedOwners: 2 });
    expect(mockClaimAndDispatchCodeReviewSandboxRetries).toHaveBeenCalledWith({
      sandboxId: 'usr-sandbox',
      destroyedAt: '2026-05-07T12:00:00.000Z',
      source: 'cloud-agent-next-notification',
    });
  });

  it('rejects invalid payloads', async () => {
    const response = await POST(makeRequest({ sandboxId: 'usr-sandbox', reason: 'sandbox_500' }));

    expect(response.status).toBe(400);
    expect(mockClaimAndDispatchCodeReviewSandboxRetries).not.toHaveBeenCalled();
  });
});
