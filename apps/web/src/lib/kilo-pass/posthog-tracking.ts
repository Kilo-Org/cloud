/**
 * Server-side PostHog tracking for Stripe Kilo Pass purchase completion.
 * Call after the purchase transaction commits.
 */
import 'server-only';

import { captureException } from '@sentry/nextjs';

import PostHogClient from '@kilocode/web-shared/lib/posthog';
import type { KiloPassCadence, KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';

export type KiloPassPurchaseKind = 'initial' | 'renewal' | 'upgrade' | 'unknown';

export type TrackKiloPassPurchaseCompletedParams = {
  distinctId: string;
  userId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  purchaseKind: KiloPassPurchaseKind;
  channel: 'stripe';
  stripeInvoiceId: string;
  amountPaidUsd: number;
  currency: string;
  livemode: boolean;
};

const posthogClient = PostHogClient();

/**
 * Shared post-response scheduling for Stripe webhooks.
 */
export { runAfterResponse } from '@/lib/after-response';

export function trackKiloPassPurchaseCompleted(params: TrackKiloPassPurchaseCompletedParams): void {
  const properties = {
    channel: params.channel,
    tier: params.tier,
    cadence: params.cadence,
    purchase_kind: params.purchaseKind,
    user_id: params.userId,
    stripe_invoice_id: params.stripeInvoiceId,
    amount_paid_usd: params.amountPaidUsd,
    currency: params.currency,
    livemode: params.livemode,
  };

  try {
    posthogClient.capture({
      distinctId: params.distinctId,
      event: 'kilo_pass_purchase_completed',
      properties,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_kilo_pass_purchase_completed' },
      extra: { properties },
    });
  }
}
