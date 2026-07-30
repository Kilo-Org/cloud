/**
 * Server-side PostHog tracking for Kilo Pass purchase completion.
 *
 * Future store-purchase completion call sites (e.g. Google Play) must call
 * `trackKiloPassPurchaseCompleted` post-commit — there is no automatic hook
 * inside `completeStoreKiloPassPurchase`.
 */
import 'server-only';

import { after } from 'next/server';
import { captureException } from '@sentry/nextjs';

import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import PostHogClient from '@/lib/posthog';
import type { KiloPassCadence, KiloPassTier } from './enums';

export type KiloPassPurchaseKind = 'initial' | 'renewal' | 'upgrade' | 'unknown';

type TrackKiloPassPurchaseCompletedBase = {
  distinctId: string;
  userId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  purchaseKind: KiloPassPurchaseKind;
};

export type TrackKiloPassPurchaseCompletedParams =
  | (TrackKiloPassPurchaseCompletedBase & {
      channel: 'app_store';
      providerTransactionId: string;
      productId: string;
      environment: string;
    })
  | (TrackKiloPassPurchaseCompletedBase & {
      channel: 'stripe';
      stripeInvoiceId: string;
      amountPaidUsd: number;
      currency: string;
      livemode: boolean;
    });

const posthogClient = PostHogClient();

/**
 * Copied from apps/web/src/lib/kiloclaw/stripe-handlers.ts:426.
 * Keeps the serverless function alive until the capture is enqueued on
 * provider-webhook paths.
 */
export async function runAfterResponse(work: () => Promise<void>): Promise<void> {
  if (IS_IN_AUTOMATED_TEST) {
    await work();
    return;
  }

  after(work);
}

export function trackKiloPassPurchaseCompleted(params: TrackKiloPassPurchaseCompletedParams): void {
  const baseProperties = {
    channel: params.channel,
    tier: params.tier,
    cadence: params.cadence,
    purchase_kind: params.purchaseKind,
    user_id: params.userId,
  };

  const properties =
    params.channel === 'app_store'
      ? {
          ...baseProperties,
          provider_transaction_id: params.providerTransactionId,
          product_id: params.productId,
          environment: params.environment,
        }
      : {
          ...baseProperties,
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
