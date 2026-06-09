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

export const client: Stripe = new Stripe(stripeSecretKey);

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

export async function safeDeleteStripeCustomer(stripeCustomerId: string) {
  try {
    await deleteStripeCustomer(stripeCustomerId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('No such customer')) {
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
  const paymentMethods = await client.paymentMethods.list({
    customer: stripeCustomerId,
    type: 'card',
  });
  return paymentMethods.data.length > 0;
}
