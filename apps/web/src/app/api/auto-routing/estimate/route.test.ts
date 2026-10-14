import { NextRequest, NextResponse } from 'next/server';
import { POST } from './route';
import { resolveOwner } from '@/lib/auto-routing-owner';
import { validatePoolEntries } from '@/lib/auto-routing-pool-validation';
import { estimateAutoRoutingProfiles } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { TRPCError } from '@trpc/server';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import type * as AutoRoutingOwner from '@/lib/auto-routing-owner';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/routers/organizations/utils');
jest.mock('@/lib/auto-routing-owner', () => ({
  ...jest.requireActual<typeof AutoRoutingOwner>('@/lib/auto-routing-owner'),
  resolveOwner: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@/lib/auto-routing-pool-validation', () => ({ validatePoolEntries: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client', () => ({
  estimateAutoRoutingProfiles: jest.fn(),
}));

const mockedOwner = jest.mocked(resolveOwner);
const mockedValidation = jest.mocked(validatePoolEntries);
const mockedEstimate = jest.mocked(estimateAutoRoutingProfiles);
const mockedSubscriptionGate = jest.mocked(requireActiveSubscriptionOrTrial);

function request(body: unknown) {
  return new NextRequest('https://example.com/api/auto-routing/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSubscriptionGate.mockResolvedValue({ isReadOnly: false, daysRemaining: Infinity });
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

it('rejects organization estimates without an active subscription or trial', async () => {
  mockedOwner.mockResolvedValue({
    ownerType: 'org',
    ownerId: 'org-1',
    userId: 'user-1',
    organizationId: 'org-1',
  });
  mockedSubscriptionGate.mockRejectedValue(
    new TRPCError({ code: 'FORBIDDEN', message: 'Active subscription or trial required' })
  );
  const response = await POST(request({ entries: [{ model: 'anthropic/claude-sonnet-4' }] }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Active subscription or trial required' });
  expect(mockedSubscriptionGate).toHaveBeenCalledWith('org-1');
  expect(mockedValidation).not.toHaveBeenCalled();
  expect(mockedEstimate).not.toHaveBeenCalled();
});

it('allows organization estimates after the subscription gate succeeds', async () => {
  mockedOwner.mockResolvedValue({
    ownerType: 'org',
    ownerId: 'org-1',
    userId: 'user-1',
    organizationId: 'org-1',
  });
  mockedEstimate.mockResolvedValue({ status: 200, body: { estimatedCostUsd: 0, pairs: [] } });
  expect((await POST(request({ entries: [{ model: 'anthropic/claude-sonnet-4' }] }))).status).toBe(
    200
  );
  expect(mockedSubscriptionGate).toHaveBeenCalledWith('org-1');
  expect(mockedEstimate).toHaveBeenCalledWith({
    ownerType: 'org',
    ownerId: 'org-1',
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
