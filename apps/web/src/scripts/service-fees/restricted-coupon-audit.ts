/**
 * Read-only restricted-coupon audit: list Stripe coupons whose applies_to.products
 * intersects known fee-bearing Kilo Pass or top-up products and alert Admin Slack.
 *
 * Usage:
 *   pnpm --filter web script:run service-fees restricted-coupon-audit
 *   pnpm --filter web script:run service-fees restricted-coupon-audit --no-alert
 *
 * This script never creates, updates, or deletes Stripe coupons or products.
 */

import { captureMessage } from '@sentry/nextjs';
import { getEnvVariable } from '@/lib/dotenvx';
import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import {
  auditRestrictedCoupons,
  listCouponSnapshotsEnsuringAppliesTo,
  parseRestrictedCouponAuditArgs,
  SERVICE_FEE_RESTRICTED_COUPON_SENTRY_TAG,
  type RestrictedCouponAlertPayload,
  type StripeCouponSnapshot,
} from '@/lib/service-fees/restricted-coupon-audit';
import { sendAdminSlackNotification } from '@/lib/slack/admin-notifications';
import { client as stripe } from '@/lib/stripe-client';

/**
 * Lists coupons paginated and guarantees applies_to is actually retrieved:
 * applies_to is not an expandable ID reference, so list payloads that omit it
 * fall back to an authoritative read-only stripe.coupons.retrieve. Both calls
 * are GETs; this function never mutates Stripe state.
 */
export async function listStripeCouponSnapshots(): Promise<StripeCouponSnapshot[]> {
  return listCouponSnapshotsEnsuringAppliesTo({
    listPage: startingAfter =>
      stripe.coupons.list({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }),
    retrieveCoupon: couponId => stripe.coupons.retrieve(couponId),
  });
}

export async function listFeeBearingStripeProductIds(): Promise<string[]> {
  const priceIds = [...getKnownStripePriceIdsForKiloPass(), requireEnv('STRIPE_TOP_UP_PRICE_ID')];
  const productIds = new Set<string>();

  for (const priceId of priceIds) {
    const price = await stripe.prices.retrieve(priceId);
    const productId = productIdFromPrice(price.product);
    if (!productId) {
      throw new Error(`fee-bearing price ${priceId} has no product id`);
    }
    productIds.add(productId);
  }

  return [...productIds].sort((left, right) => left.localeCompare(right));
}

export async function run(...args: string[]): Promise<void> {
  const parsed = parseRestrictedCouponAuditArgs(args);
  const report = await auditRestrictedCoupons({
    listCoupons: listStripeCouponSnapshots,
    listFeeBearingProductIds: listFeeBearingStripeProductIds,
    sendAlert: parsed.alert ? sendAdminSlackNotification : undefined,
    capture: parsed.alert ? captureRestrictedCouponDetection : undefined,
  });
  if (report.findings.length > 0) {
    process.exitCode = 1;
  }
}

function captureRestrictedCouponDetection(payload: RestrictedCouponAlertPayload): void {
  captureMessage(SERVICE_FEE_RESTRICTED_COUPON_SENTRY_TAG, {
    level: 'error',
    tags: { [SERVICE_FEE_RESTRICTED_COUPON_SENTRY_TAG]: 'true' },
    extra: payload,
  });
}

function requireEnv(name: string): string {
  const value = getEnvVariable(name).trim();
  if (!value) {
    throw new Error(`Missing required env var for restricted-coupon audit: ${name}`);
  }
  return value;
}

function productIdFromPrice(product: unknown): string | null {
  if (typeof product === 'string') return product;
  if (product && typeof product === 'object' && 'id' in product) {
    const id = product.id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
