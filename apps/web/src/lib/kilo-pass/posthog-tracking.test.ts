import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { trackKiloPassPurchaseCompleted as trackKiloPassPurchaseCompletedType } from './posthog-tracking';
import { KiloPassCadence, KiloPassTier } from './enums';

jest.mock('@/lib/posthog', () => {
  const mockCapture = jest.fn();
  return {
    __esModule: true,
    default: jest.fn(() => ({ capture: mockCapture })),
    mockCapture,
  };
});

jest.mock('@sentry/nextjs', () => {
  const mockCaptureException = jest.fn();
  return {
    captureException: mockCaptureException,
    mockCaptureException,
  };
});

jest.mock('next/server', () => ({
  after: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  IS_IN_AUTOMATED_TEST: true,
}));

let trackKiloPassPurchaseCompleted: typeof trackKiloPassPurchaseCompletedType;

const posthogMock: { mockCapture: jest.Mock } = jest.requireMock('@/lib/posthog');
const sentryMock: { mockCaptureException: jest.Mock } = jest.requireMock('@sentry/nextjs');
const { mockCapture } = posthogMock;
const { mockCaptureException } = sentryMock;

beforeAll(async () => {
  ({ trackKiloPassPurchaseCompleted } = await import('./posthog-tracking'));
});

describe('Kilo Pass PostHog tracking', () => {
  beforeEach(() => {
    mockCapture.mockReset();
    mockCaptureException.mockReset();
  });

  it('captures app_store purchase completed with snake_case wire properties', () => {
    trackKiloPassPurchaseCompleted({
      channel: 'app_store',
      distinctId: 'user@example.com',
      userId: 'user-123',
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      purchaseKind: 'initial',
      providerTransactionId: 'tx-abc',
      productId: 'kilopass.tier49.monthly.v1',
      environment: 'Sandbox',
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user@example.com',
      event: 'kilo_pass_purchase_completed',
      properties: {
        channel: 'app_store',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        purchase_kind: 'initial',
        user_id: 'user-123',
        provider_transaction_id: 'tx-abc',
        product_id: 'kilopass.tier49.monthly.v1',
        environment: 'Sandbox',
      },
    });
  });

  it('captures stripe purchase completed with snake_case wire properties', () => {
    trackKiloPassPurchaseCompleted({
      channel: 'stripe',
      distinctId: 'user@example.com',
      userId: 'user-456',
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
      purchaseKind: 'renewal',
      stripeInvoiceId: 'in_abc',
      amountPaidUsd: 19,
      currency: 'usd',
      livemode: true,
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user@example.com',
      event: 'kilo_pass_purchase_completed',
      properties: {
        channel: 'stripe',
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Yearly,
        purchase_kind: 'renewal',
        user_id: 'user-456',
        stripe_invoice_id: 'in_abc',
        amount_paid_usd: 19,
        currency: 'usd',
        livemode: true,
      },
    });
  });

  it('reports capture failures without throwing', () => {
    const error = new Error('capture failed');
    mockCapture.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      trackKiloPassPurchaseCompleted({
        channel: 'app_store',
        distinctId: 'user@example.com',
        userId: 'user-123',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        purchaseKind: 'upgrade',
        providerTransactionId: 'tx-abc',
        productId: 'kilopass.tier49.monthly.v1',
        environment: 'Production',
      })
    ).not.toThrow();

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'posthog_kilo_pass_purchase_completed' },
      extra: {
        properties: {
          channel: 'app_store',
          tier: KiloPassTier.Tier49,
          cadence: KiloPassCadence.Monthly,
          purchase_kind: 'upgrade',
          user_id: 'user-123',
          provider_transaction_id: 'tx-abc',
          product_id: 'kilopass.tier49.monthly.v1',
          environment: 'Production',
        },
      },
    });
  });
});
