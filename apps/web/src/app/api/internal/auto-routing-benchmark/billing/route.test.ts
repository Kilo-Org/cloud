import { ZodError } from 'zod';
import { POST as reserve } from './reserve/route';
import { POST as settle } from './settle/route';
import {
  BenchmarkBillingError,
  reserveBenchmarkCredits,
  settleBenchmarkCredits,
} from '@/lib/auto-routing-benchmark-billing';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'benchmark-billing-secret',
}));
jest.mock('@/lib/auto-routing-benchmark-billing', () => {
  const actual = jest.requireActual('@/lib/auto-routing-benchmark-billing');
  return { ...actual, reserveBenchmarkCredits: jest.fn(), settleBenchmarkCredits: jest.fn() };
});

const mockReserve = jest.mocked(reserveBenchmarkCredits);
const mockSettle = jest.mocked(settleBenchmarkCredits);
const input = {
  admissionId: 'admission',
  ownerType: 'user',
  ownerId: 'oauth/test',
  items: [{ model: 'test/model', variant: null, estimatedCostUsd: 3 }],
};

beforeEach(() => jest.clearAllMocks());

function request(body: unknown, token = 'benchmark-billing-secret') {
  return new Request('http://localhost/api/internal/auto-routing-benchmark/billing', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('internal benchmark billing routes', () => {
  it.each([reserve, settle])(
    'rejects unauthenticated callers before processing billing',
    async handler => {
      expect((await handler(request(input, 'wrong-secret'))).status).toBe(401);
      expect((await handler(new Request('http://localhost', { method: 'POST' }))).status).toBe(401);
      expect(mockReserve).not.toHaveBeenCalled();
      expect(mockSettle).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid JSON without billing side effects', async () => {
    const response = await reserve(
      new Request('http://localhost', {
        method: 'POST',
        headers: { authorization: `Bearer ${'benchmark-billing-secret'}` },
        body: '{',
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('returns the atomic hold response', async () => {
    const held = {
      admissionId: 'admission',
      heldCostUsd: 3,
      items: [
        {
          model: 'test/model',
          variant: null,
          estimatedCostUsd: 3,
          status: 'held' as const,
          chargedCostUsd: null,
        },
      ],
    };
    mockReserve.mockResolvedValue(held);
    const response = await reserve(request(input));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(held);
    expect(mockReserve).toHaveBeenCalledWith(input);
  });

  it('returns clear insufficient-credit amounts with HTTP 402', async () => {
    mockReserve.mockRejectedValue(
      new BenchmarkBillingError(402, 'insufficient_credits', {
        availableCostUsd: 1,
        requiredCostUsd: 3,
      })
    );
    const response = await reserve(request(input));
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'insufficient_credits',
      availableCostUsd: 1,
      requiredCostUsd: 3,
    });
  });

  it.each([
    [403, 'owner_blocked'],
    [404, 'owner_not_found'],
    [404, 'hold_not_found'],
    [409, 'idempotency_conflict'],
  ] as const)('preserves billing error %s %s', async (status, code) => {
    mockSettle.mockRejectedValue(new BenchmarkBillingError(status, code));
    const response = await settle(request(input));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it('rejects invalid billing input with HTTP 400', async () => {
    mockReserve.mockRejectedValue(new ZodError([]));
    const response = await reserve(request(input));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
  });

  it('passes terminal run cost through without multiplying or capping it', async () => {
    const terminal = {
      admissionId: 'admission',
      ownerType: 'user',
      ownerId: 'oauth/test',
      model: 'test/model',
      variant: null,
      runId: 'run',
      actualCostUsd: 5,
    };
    const reply = {
      admissionId: 'admission',
      model: 'test/model',
      variant: null,
      runId: 'run',
      chargedCostUsd: 5,
      releasedCostUsd: 0,
    };
    mockSettle.mockResolvedValue(reply);
    const response = await settle(request(terminal));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(reply);
    expect(mockSettle).toHaveBeenCalledWith(terminal);
  });
});
