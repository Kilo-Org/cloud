import { client } from '@/lib/stripe-client';

export type PaymentMethodInfo = NonNullable<Awaited<ReturnType<typeof retrievePaymentMethodInfo>>>;
/**
 * Retrieves payment method info from Stripe for a given payment method ID.
 * Returns null if the payment method ID is null/undefined, doesn't exist, or was deleted.
 */

export async function retrievePaymentMethodInfo(stripePaymentMethodId: string | null | undefined) {
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
  } catch {
    // Payment method may have been deleted from Stripe
    return null;
  }
}
