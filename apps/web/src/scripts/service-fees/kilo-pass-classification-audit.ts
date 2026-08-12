/**
 * Read-only pre-release audit: can active Stripe-managed Personal Kilo Pass and
 * self-service org Kilo Pass subscriptions be classified for service-fee invoices?
 *
 * Usage:
 *   pnpm --filter web script:run service-fees kilo-pass-classification-audit
 *
 * This script never creates, updates, or deletes Stripe or database records.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { kilo_pass_org_agreements, kilo_pass_subscriptions } from '@kilocode/db/schema';
import { KiloPassOrgPurchaseChannel, KiloPassPaymentProvider } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { SEAT_PRODUCT_IDS } from '@/lib/organizations/stripe-seat-line-items';
import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import {
  auditKiloPassClassifications,
  LIVE_ORG_KILO_PASS_STATES,
  LIVE_PERSONAL_KILO_PASS_STATUSES,
  type KiloPassClassificationAuditStore,
  type StripeSubscriptionSnapshot,
} from '@/lib/service-fees/kilo-pass-classification-audit';
import { assertServiceFeeAuditReadOnly } from '@/lib/service-fees/read-only';
import { client as stripe } from '@/lib/stripe-client';

export function createDatabaseKiloPassClassificationStore(): KiloPassClassificationAuditStore {
  return {
    async listPersonalRows() {
      return db
        .select({
          id: kilo_pass_subscriptions.id,
          kiloUserId: kilo_pass_subscriptions.kilo_user_id,
          stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
          status: kilo_pass_subscriptions.status,
          tier: kilo_pass_subscriptions.tier,
          cadence: kilo_pass_subscriptions.cadence,
        })
        .from(kilo_pass_subscriptions)
        .where(
          and(
            eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.Stripe),
            inArray(kilo_pass_subscriptions.status, [...LIVE_PERSONAL_KILO_PASS_STATUSES])
          )
        );
    },
    async listOrganizationRows() {
      return db
        .select({
          id: kilo_pass_org_agreements.id,
          organizationId: kilo_pass_org_agreements.parent_organization_id,
          providerSubscriptionId: kilo_pass_org_agreements.provider_subscription_id,
          providerSeatAddOnItemId: kilo_pass_org_agreements.provider_seat_add_on_item_id,
          state: kilo_pass_org_agreements.state,
          purchaseChannel: kilo_pass_org_agreements.purchase_channel,
        })
        .from(kilo_pass_org_agreements)
        .where(
          and(
            eq(kilo_pass_org_agreements.purchase_channel, KiloPassOrgPurchaseChannel.SelfServe),
            inArray(kilo_pass_org_agreements.state, [...LIVE_ORG_KILO_PASS_STATES])
          )
        );
    },
  };
}

export async function retrieveStripeSubscriptionSnapshot(
  subscriptionId: string
): Promise<StripeSubscriptionSnapshot | null> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    return {
      id: subscription.id,
      status: subscription.status,
      metadata: subscription.metadata ?? {},
      items: subscription.items.data.map(item => ({
        id: item.id,
        priceId: item.price?.id ?? null,
        productId: productIdFromPrice(item.price?.product),
      })),
    };
  } catch (error) {
    if (isMissingStripeResource(error)) return null;
    throw error;
  }
}

export async function run(...args: string[]): Promise<void> {
  assertServiceFeeAuditReadOnly(args);
  const report = await auditKiloPassClassifications({
    knownKiloPassPriceIds: new Set(getKnownStripePriceIdsForKiloPass()),
    seatProductIds: SEAT_PRODUCT_IDS,
    store: createDatabaseKiloPassClassificationStore(),
    retrieveSubscription: retrieveStripeSubscriptionSnapshot,
  });
  if (report.unclassifiableCount > 0) {
    process.exitCode = 1;
  }
}

function productIdFromPrice(product: unknown): string | null {
  if (typeof product === 'string') return product;
  if (product && typeof product === 'object' && 'id' in product) {
    const id = product.id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function isMissingStripeResource(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'resource_missing'
  );
}
