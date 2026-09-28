import 'server-only';
import { client } from '@/lib/stripe-client';
import { APP_URL } from '@/lib/constants';
import {
  ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS,
  DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
} from '@/lib/autoTopUpConstants';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import {
  createTopUpCheckoutSession,
  mergeServiceFeeCommercialMetadata,
  prepareTopUpCheckoutFee,
  type ServiceFeeCheckoutDependencies,
} from '@/lib/service-fees/checkout';
import { createServiceFeeStores } from '@/lib/service-fees/drizzle-store';
import { getEffectiveOrganizationServiceFeeExemption } from '@/lib/service-fees/organization-exemptions';

export async function isOrgAutoTopUpFeatureEnabled(organizationId: string): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' ||
    (await isFeatureFlagEnabled('org-auto-topup', organizationId))
  );
}

function createOrgAutoTopUpFeeDeps(): ServiceFeeCheckoutDependencies {
  const stores = createServiceFeeStores();
  return {
    store: stores.assessments,
    findEffectiveExemption: async (organizationId, at) =>
      getEffectiveOrganizationServiceFeeExemption({
        store: stores.exemptions,
        organizationId,
        at,
      }),
    stripe: client,
    listCheckoutLineItems: (sessionId, params) =>
      client.checkout.sessions.listLineItems(sessionId, params),
    expireCheckoutSession: sessionId => client.checkout.sessions.expire(sessionId),
  };
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
  const feeDeps = createOrgAutoTopUpFeeDeps();
  const prepared = await prepareTopUpCheckoutFee({
    flow: 'organization_auto_top_up_setup',
    principalMinor: amountCents,
    kiloUserId,
    organizationId,
    stripeCustomerId,
    taxPrincipal: { kind: 'inline' },
    deps: feeDeps,
  });

  const checkoutSession = await createTopUpCheckoutSession({
    prepared,
    buildSessionParams: feeLine => ({
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
        ...(feeLine ? [feeLine] : []),
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
      metadata: mergeServiceFeeCommercialMetadata(
        { type: 'org-auto-topup-setup', kiloUserId, organizationId },
        prepared.commercialMetadata
      ),
      payment_intent_data: {
        metadata: mergeServiceFeeCommercialMetadata(
          {
            type: 'org-auto-topup-setup',
            kiloUserId,
            organizationId,
            amountCents: String(amountCents),
          },
          prepared.commercialMetadata
        ),
        setup_future_usage: 'off_session',
      },
      expand: ['line_items.data.price.product'],
    }),
    createSession: params => client.checkout.sessions.create(params),
    deps: feeDeps,
  });

  return typeof checkoutSession.url === 'string' ? checkoutSession.url : null;
}
