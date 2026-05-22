import { NextRequest, NextResponse } from 'next/server';
import {
  insertKiloClawSubscriptionChangeLog,
  type KiloClawSubscription,
  type User,
} from '@kilocode/db';

import { processPersonalKiloClawPaidConversion } from '@/lib/impact/kiloclaw-referrals';
import { resolveCurrentPersonalSubscriptionRow } from '@/lib/kiloclaw/current-personal-subscription';
import { getUserFromAuth } from '@/lib/user/server';
import { ImpactReferralPaymentProvider } from '@kilocode/db/schema-types';

// Test-fixture boundary: only the fields the route actually reads are
// populated. Casting via Partial<T> -> T (rather than `as never` or
// `as unknown as T`) keeps the structural type relationship intact, so any
// required field the route starts to read in the future will surface as a
// concrete TS error here instead of silently `undefined`.
function adminUserFixture(overrides: Partial<User> & Pick<User, 'id'>): User {
  return overrides as Partial<User> as User;
}

function subscriptionFixture(
  overrides: Partial<KiloClawSubscription> & Pick<KiloClawSubscription, 'id'>
): KiloClawSubscription {
  return overrides as Partial<KiloClawSubscription> as KiloClawSubscription;
}

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/current-personal-subscription', () => ({
  resolveCurrentPersonalSubscriptionRow: jest.fn(),
}));

jest.mock('@/lib/impact/kiloclaw-referrals', () => ({
  processPersonalKiloClawPaidConversion: jest.fn(),
}));

jest.mock('@kilocode/db', () => ({
  insertKiloClawSubscriptionChangeLog: jest.fn(),
}));

import { POST } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockResolveCurrentPersonalSubscriptionRow = jest.mocked(
  resolveCurrentPersonalSubscriptionRow
);
const mockProcessPersonalKiloClawPaidConversion = jest.mocked(
  processPersonalKiloClawPaidConversion
);
const mockInsertKiloClawSubscriptionChangeLog = jest.mocked(insertKiloClawSubscriptionChangeLog);

function createRequest(body: unknown) {
  return new NextRequest(
    'http://localhost:3000/admin/api/users/user_123/kiloclaw-referral-eligibility',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
      },
    }
  );
}

describe('POST /admin/api/users/[id]/kiloclaw-referral-eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: adminUserFixture({ id: 'admin_123' }),
      authFailedResponse: null,
    });
    mockResolveCurrentPersonalSubscriptionRow.mockResolvedValue({
      subscription: subscriptionFixture({
        id: 'subscription_123',
        user_id: 'user_123',
        plan: 'standard',
        status: 'active',
      }),
    } as Awaited<ReturnType<typeof resolveCurrentPersonalSubscriptionRow>>);
    mockInsertKiloClawSubscriptionChangeLog.mockResolvedValue(undefined);
    mockProcessPersonalKiloClawPaidConversion.mockResolvedValue({
      shouldEnqueueAffiliateSale: false,
      winningTouchType: 'referral',
      conversionId: 'conversion_123',
      disqualificationReason: null,
    });
  });

  it('returns authFailedResponse for unauthorized operators', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Unauthorized' },
        { status: 401 }
      ),
    });

    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'user_123' }) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ success: false, error: 'Unauthorized' });
  });

  it('records an admin override and derives Stripe provider for invoice-backed conversions', async () => {
    const response = await POST(
      createRequest({
        sourcePaymentId: 'in_123',
        orderId: 'in_123',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: '2026-04-09T00:00:00.000Z',
        sourceType: 'manual_adjustment',
      }),
      { params: Promise.resolve({ id: 'user_123' }) }
    );

    expect(mockInsertKiloClawSubscriptionChangeLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscriptionId: 'subscription_123',
        actor: {
          actorType: 'user',
          actorId: 'admin_123',
        },
        action: 'admin_override',
        reason: 'referral_eligibility_override:manual_adjustment:in_123',
      })
    );

    expect(mockProcessPersonalKiloClawPaidConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_123',
        sourcePaymentId: 'in_123',
        paymentProvider: ImpactReferralPaymentProvider.Stripe,
        qualificationContext: {
          sourceType: 'manual_adjustment',
          overrideEligible: true,
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      disposition: {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'referral',
        conversionId: 'conversion_123',
        disqualificationReason: null,
      },
    });
  });

  it.each(['pi_123', 'ch_123'])(
    'derives Stripe provider for %s source payment IDs',
    async sourcePaymentId => {
      await POST(
        createRequest({
          sourcePaymentId,
          orderId: sourcePaymentId,
          amount: 9,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard',
          itemName: 'KiloClaw Standard Plan',
          convertedAt: '2026-04-09T00:00:00.000Z',
          sourceType: 'manual_adjustment',
        }),
        { params: Promise.resolve({ id: 'user_123' }) }
      );

      expect(mockProcessPersonalKiloClawPaidConversion).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePaymentId,
          paymentProvider: ImpactReferralPaymentProvider.Stripe,
        })
      );
    }
  );

  it('uses an explicit payment provider when supplied', async () => {
    await POST(
      createRequest({
        sourcePaymentId: 'manual-payment-123',
        orderId: 'manual-payment-123',
        paymentProvider: ImpactReferralPaymentProvider.Stripe,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        convertedAt: '2026-04-09T00:00:00.000Z',
        sourceType: 'manual_adjustment',
      }),
      { params: Promise.resolve({ id: 'user_123' }) }
    );

    expect(mockProcessPersonalKiloClawPaidConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaymentId: 'manual-payment-123',
        paymentProvider: ImpactReferralPaymentProvider.Stripe,
      })
    );
  });

  it('returns 409 when no current personal subscription exists for the override target', async () => {
    mockResolveCurrentPersonalSubscriptionRow.mockResolvedValue(null);

    const response = await POST(
      createRequest({
        sourcePaymentId: 'invoice_123',
        orderId: 'invoice_123',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        convertedAt: '2026-04-09T00:00:00.000Z',
        sourceType: 'test',
      }),
      { params: Promise.resolve({ id: 'user_123' }) }
    );

    expect(mockInsertKiloClawSubscriptionChangeLog).not.toHaveBeenCalled();
    expect(mockProcessPersonalKiloClawPaidConversion).not.toHaveBeenCalled();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'No current personal KiloClaw subscription found for referral override',
    });
  });
});
