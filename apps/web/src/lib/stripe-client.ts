import { getEnvVariable } from '@/lib/dotenvx';
import 'server-only';
import Stripe from 'stripe';
import { captureMessage } from '@sentry/nextjs';

const stripeSecretKey = getEnvVariable('STRIPE_SECRET_KEY');
if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}
const skipStripeApi =
  process.env.NODE_ENV !== 'production' && process.env.SKIP_STRIPE_API === 'true';

export const client: Stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2025-10-29.clover',
});

type ConstrainedMetadata = UserConstrainedMetadata | OrganizationConstrainedMetdata;

type OrganizationConstrainedMetdata = {
  metadata: {
    organizationId: string;
  };
};

type UserConstrainedMetadata = {
  metadata: {
    kiloUserId: string;
  };
};

type CreateParams = Omit<Stripe.CustomerCreateParams, 'metadata'> & ConstrainedMetadata;

export async function createStripeCustomer(
  customer: CreateParams
): Promise<Pick<Stripe.Customer, 'id'>> {
  if (skipStripeApi) {
    const metadataId =
      'kiloUserId' in customer.metadata
        ? customer.metadata.kiloUserId
        : customer.metadata.organizationId;
    return { id: `cus_local_${metadataId}` };
  }

  return client.customers.create(customer);
}

export async function deleteStripeCustomer(stripeCustomerId: string) {
  if (skipStripeApi) return;

  await client.customers.del(stripeCustomerId);
}

/**
 * Stripe answers `No such customer` (code `resource_missing`) when the id we
 * stored does not exist in the account the secret key belongs to — the customer
 * was deleted in Stripe, or the row points at another Stripe account (a local
 * database against a different key). Callers treat that as an absent customer
 * rather than a failure: a missing customer owns no payment methods and needs
 * no removal.
 */
function isMissingStripeCustomerError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No such customer');
}

export async function safeDeleteStripeCustomer(stripeCustomerId: string) {
  try {
    await deleteStripeCustomer(stripeCustomerId);
  } catch (error) {
    if (isMissingStripeCustomerError(error)) {
      const message = `Stripe customer ${stripeCustomerId} not found, continuing with GDPR removal`;
      console.log(message);
      captureMessage(message, {
        level: 'info',
        tags: { source: 'stripe-customer-removal' },
      });
      return;
    }
    throw error;
  }
}

export async function hasPaymentMethodInStripe({
  stripeCustomerId,
}: {
  stripeCustomerId: string;
}): Promise<boolean> {
  if (skipStripeApi) return false;

  // This function may become redundant if our in-db administration is accurate.
  try {
    const paymentMethods = await client.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    });
    return paymentMethods.data.length > 0;
  } catch (error) {
    if (!isMissingStripeCustomerError(error)) throw error;
    // The profile page reads this on every render. A stored id Stripe no
    // longer knows must degrade to "no payment method on file" — rethrowing
    // turned the whole profile into the error boundary's "Something went
    // wrong" page for that user.
    const message = `Stripe customer ${stripeCustomerId} not found, treating as no payment method`;
    console.log(message);
    captureMessage(message, {
      level: 'info',
      tags: { source: 'stripe-payment-method-lookup' },
    });
    return false;
  }
}
