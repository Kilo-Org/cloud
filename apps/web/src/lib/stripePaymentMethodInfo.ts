import Stripe from 'stripe';
import { client } from '@kilocode/web-shared/lib/stripe-client';

export type PaymentMethodInfo = {
  type: Stripe.PaymentMethod.Type;
  last4: string | null;
  brand: string | null;
  linkEmail: string | null;
  stripePaymentMethodId: string;
};

/**
 * Retrieves payment method info from Stripe for a given payment method ID.
 *
 * Returns null only when the id is null/undefined, or when Stripe reports the
 * resource is missing because the payment method was deleted. Every other
 * Stripe failure — authentication, rate limit, permissions, network — is
 * thrown to the caller, so it is reported instead of being shown as an absent
 * payment method.
 */
export async function retrievePaymentMethodInfo(
  stripePaymentMethodId: string | null | undefined
): Promise<PaymentMethodInfo | null> {
  if (!stripePaymentMethodId) {
    return null;
  }
  try {
    const paymentMethod = await client.paymentMethods.retrieve(stripePaymentMethodId);
    return {
      type: paymentMethod.type,
      last4: paymentMethod.card?.last4 ?? null,
      brand: paymentMethod.card?.brand ?? null,
      linkEmail: paymentMethod.link?.email ?? null,
      stripePaymentMethodId: paymentMethod.id,
    };
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      return null;
    }
    throw error;
  }
}
