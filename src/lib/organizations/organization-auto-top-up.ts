import 'server-only';
import { client } from '@/lib/stripe-client';
import { APP_URL } from '@/lib/constants';
import {
  ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS,
  DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
} from '@/lib/autoTopUpConstants';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

export async function isOrgAutoTopUpFeatureEnabled(organizationId: string): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' ||
    (await isFeatureFlagEnabled('org-auto-topup', organizationId))
  );
}

/**
 * Creates a Stripe checkout session for organization auto-top-up setup.
 * Similar to user auto-top-up but with organization metadata.
 */
export async function createOrgAutoTopUpSetupCheckoutSession(
  kiloUserId: string,
  organizationId: string,
  stripeCustomerId: string,
  amountCents: number = DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS
): Promise<string | null> {
  const amountDollars = amountCents / 100;

  const checkoutSession = await client.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    billing_address_collection: 'required',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Organization Credit Top-Up with Auto-Refill Setup',
            description: `Initial $${amountDollars} top-up. Your card will be saved for automatic $${amountDollars} top ups when balance drops below $${ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS}.`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    invoice_creation: {
      enabled: true,
    },
    customer_update: {
      name: 'auto',
      address: 'auto',
    },
    tax_id_collection: {
      enabled: true,
      required: 'never',
    },
    success_url: `${APP_URL}/organizations/${organizationId}/payment-details?auto_topup_setup=success`,
    cancel_url: `${APP_URL}/organizations/${organizationId}/payment-details?auto_topup_setup=cancelled`,
    payment_intent_data: {
      metadata: {
        type: 'org-auto-topup-setup',
        kiloUserId,
        organizationId,
        amountCents: String(amountCents),
      },
      setup_future_usage: 'off_session',
    },
  });

  return typeof checkoutSession.url === 'string' ? checkoutSession.url : null;
}
