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
