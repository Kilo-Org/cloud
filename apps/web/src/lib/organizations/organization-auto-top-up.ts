import 'server-only';
import { client } from '@kilocode/web-shared/lib/stripe-client';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getPaidCreditTerms } from '@kilocode/web-shared/lib/paidCreditPolicy.server';
import { formatCents } from '@/lib/utils';
import {
  DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
  DEFAULT_ORG_AUTO_TOP_UP_THRESHOLD_CENTS,
} from '@kilocode/web-shared/lib/autoTopUpConstants';
import { isFeatureFlagEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import {
  createTopUpCheckoutSession,
  mergeServiceFeeCommercialMetadata,
  prepareTopUpCheckoutFee,
  type ServiceFeeCheckoutDependencies,
} from '@kilocode/web-shared/lib/service-fees/checkout';
import { createServiceFeeStores } from '@kilocode/web-shared/lib/service-fees/drizzle-store';
import { getEffectiveOrganizationServiceFeeExemption } from '@kilocode/web-shared/lib/service-fees/organization-exemptions';

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
  amountCents: number = DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
  thresholdCents: number = DEFAULT_ORG_AUTO_TOP_UP_THRESHOLD_CENTS
): Promise<string | null> {
  const paidCreditTerms = getPaidCreditTerms('stripe');
  const amountLabel = formatCents(amountCents);
  const thresholdLabel = formatCents(thresholdCents);
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
      ...(paidCreditTerms === 'one_year' && {
        custom_text: {
          submit: {
            message:
              'Purchased credits expire one year after purchase. Existing credits keep their current terms. Promotional and bonus credits may expire sooner.',
          },
        },
      }),
      customer: stripeCustomerId,
      billing_address_collection: 'required',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Organization Credit Top-Up with Auto-Refill Setup',
              description: `Initial ${amountLabel} top-up. Your card will be saved for automatic ${amountLabel} top ups when balance drops below ${thresholdLabel}.`,
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
        {
          type: 'org-auto-topup-setup',
          kiloUserId,
          organizationId,
          paid_credit_policy: paidCreditTerms,
        },
        prepared.commercialMetadata
      ),
      payment_intent_data: {
        metadata: mergeServiceFeeCommercialMetadata(
          {
            type: 'org-auto-topup-setup',
            kiloUserId,
            organizationId,
            amountCents: String(amountCents),
            paid_credit_policy: paidCreditTerms,
            thresholdCents: String(thresholdCents),
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
