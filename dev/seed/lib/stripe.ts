import Stripe from 'stripe';

let cachedClient: Stripe | null = null;

function getSeedStripeClient(): Stripe {
  if (cachedClient) return cachedClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Run `vercel env pull` so dev seeds can create Stripe ' +
        'customers (the real signup flow does the same).'
    );
  }
  if (!secretKey.startsWith('sk_test_')) {
    throw new Error(
      `STRIPE_SECRET_KEY does not look like a test-mode key (expected sk_test_…). Refusing ` +
        `to create real Stripe customers from a dev seed script.`
    );
  }

  cachedClient = new Stripe(secretKey);
  return cachedClient;
}

export async function createSeedStripeCustomer(params: {
  email: string;
  name: string;
  kiloUserId: string;
}): Promise<Stripe.Customer> {
  return getSeedStripeClient().customers.create({
    email: params.email,
    name: params.name,
    metadata: { kiloUserId: params.kiloUserId, source: 'dev-seed' },
  });
}

export async function createSeedSeatSubscription(params: {
  stripeCustomerId: string;
  priceId: string;
  seatCount: number;
  kiloUserId: string;
  organizationId: string;
}): Promise<Stripe.Subscription> {
  const stripe = getSeedStripeClient();
  const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', {
    customer: params.stripeCustomerId,
  });
  await stripe.customers.update(params.stripeCustomerId, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  return stripe.subscriptions.create({
    customer: params.stripeCustomerId,
    items: [{ price: params.priceId, quantity: params.seatCount }],
    default_payment_method: paymentMethod.id,
    metadata: {
      type: 'seats',
      kiloUserId: params.kiloUserId,
      organizationId: params.organizationId,
      seats: String(params.seatCount),
      planType: 'teams',
      source: 'dev-seed',
    },
  });
}

export async function deleteSeedStripeCustomer(stripeCustomerId: string): Promise<void> {
  try {
    await getSeedStripeClient().customers.del(stripeCustomerId);
  } catch (error) {
    console.warn(
      `[dev-seed] Failed to clean up Stripe customer ${stripeCustomerId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
