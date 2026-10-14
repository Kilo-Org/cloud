import { NextRequest, NextResponse } from 'next/server';
import { POST } from './route';
import { resolveOwner } from '@/lib/auto-routing-owner';
import { validatePoolEntries } from '@/lib/auto-routing-pool-validation';
import { estimateAutoRoutingProfiles } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';

jest.mock('@/lib/auto-routing-owner', () => ({ resolveOwner: jest.fn() }));
jest.mock('@/lib/auto-routing-pool-validation', () => ({ validatePoolEntries: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client', () => ({
  estimateAutoRoutingProfiles: jest.fn(),
}));

const mockedOwner = jest.mocked(resolveOwner);
const mockedValidation = jest.mocked(validatePoolEntries);
const mockedEstimate = jest.mocked(estimateAutoRoutingProfiles);

function request(body: unknown) {
  return new NextRequest('https://example.com/api/auto-routing/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedOwner.mockResolvedValue({
    ownerType: 'user',
    ownerId: 'user-1',
    userId: 'user-1',
    organizationId: null,
  });
  mockedValidation.mockResolvedValue({
    ok: true,
    entries: [{ model: 'anthropic/claude-sonnet-4' }],
  });
});

it('requires authenticated owner access before requesting an estimate', async () => {
  mockedOwner.mockResolvedValue({
    response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
  });
  expect((await POST(request({ entries: [{ model: 'anthropic/claude-sonnet-4' }] }))).status).toBe(
    401
  );
  expect(mockedEstimate).not.toHaveBeenCalled();
});

it('uses the authenticated owner and returns exact effort estimates and charges', async () => {
  const body = {
    estimatedCostUsd: 0.25,
    pairs: [
      {
        entry: { model: 'anthropic/claude-sonnet-4', variant: 'high' },
        status: 'pending' as const,
        estimatedCostUsd: 0.25,
        chargedCostUsd: null,
      },
      {
        entry: { model: 'anthropic/claude-sonnet-4', variant: 'low' },
        status: 'ready' as const,
        estimatedCostUsd: 0,
        chargedCostUsd: 0.1,
      },
    ],
  };
  mockedEstimate.mockResolvedValue({ status: 200, body });
  const response = await POST(
    request({
      ownerType: 'org',
      ownerId: 'spoofed',
      entries: [{ model: 'anthropic/claude-sonnet-4' }],
    })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(body);
  expect(mockedEstimate).toHaveBeenCalledWith({
    ownerType: 'user',
    ownerId: 'user-1',
    entries: [{ model: 'anthropic/claude-sonnet-4' }],
  });
});

it('rejects catalog-ineligible models without contacting the worker', async () => {
  mockedValidation.mockResolvedValue({
    ok: false,
    error: { reason: 'unknown_model', message: 'Unknown model' },
  });
  expect((await POST(request({ entries: [{ model: 'removed/model' }] }))).status).toBe(400);
  expect(mockedEstimate).not.toHaveBeenCalled();
});

it('preserves insufficient-credit errors', async () => {
  mockedEstimate.mockResolvedValue({ status: 402, body: { error: 'Insufficient owner credits' } });
  const response = await POST(request({ entries: [{ model: 'anthropic/claude-sonnet-4' }] }));
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({ error: 'Insufficient owner credits' });
});
