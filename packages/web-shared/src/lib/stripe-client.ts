import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import 'server-only';
import Stripe from 'stripe';
import { captureMessage } from '@sentry/nextjs';

const stripeSecretKey = getEnvVariable('STRIPE_SECRET_KEY');
if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY environment variable is not set');
}
const skipStripeApi =
  process.env.NODE_ENV !== 'production' && process.env.SKIP_STRIPE_API === 'true';

// Stripe rejects requests that hit a locked object ("another API request or
// Stripe process is currently accessing it") and advises retrying; the SDK
// retries those with exponential backoff and jitter (0.5s doubling, 5s cap). The stripe@23
// default of 2 retries covers only ~1.5s and still let webhook contention fail,
// so 4 retries stretch the window to roughly 4-7.5s while staying bounded.
const STRIPE_MAX_NETWORK_RETRIES = 4;

export const client: Stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2026-09-30.endive',
  maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
});

// The profile page asks whether a customer has a card on every render, and the
// answer only changes when a card is attached to or detached from that
// customer. Serve the last answer for a short window so a render does not wait
// on a Stripe round trip (which the client retries up to 4 times); callers clear
// it through `invalidateStripePaymentMethodCache` when the cards change.
const PAYMENT_METHOD_LOOKUP_TTL_MS = 60 * 1000;
const PAYMENT_METHOD_LOOKUP_MAX_ENTRIES = 2000;

type PaymentMethodLookup = { hasPaymentMethod: boolean; expiresAt: number };

const paymentMethodLookups = new Map<string, PaymentMethodLookup>();

/**
 * Drops the cached payment-method answer for a customer. Call it after a card
 * is attached to or detached from that customer, so the next read goes back to
 * Stripe. A webhook and a page render can run in different server instances, so
 * this only clears the instance that handles the change; the cache lifetime
 * bounds how long any other instance keeps the previous answer.
 */
export function invalidateStripePaymentMethodCache(stripeCustomerId: string): void {
  paymentMethodLookups.delete(stripeCustomerId);
}

function readCachedPaymentMethodLookup(stripeCustomerId: string): boolean | undefined {
  const lookup = paymentMethodLookups.get(stripeCustomerId);
  if (!lookup) return undefined;
  if (lookup.expiresAt <= Date.now()) {
    paymentMethodLookups.delete(stripeCustomerId);
    return undefined;
  }
  return lookup.hasPaymentMethod;
}

function writeCachedPaymentMethodLookup(stripeCustomerId: string, hasPaymentMethod: boolean) {
  if (!paymentMethodLookups.has(stripeCustomerId)) {
    // Map iteration follows insertion order, so the first key is the oldest
    // entry; one eviction keeps the map bounded on a long-lived instance.
    const oldest = paymentMethodLookups.keys().next();
    if (paymentMethodLookups.size >= PAYMENT_METHOD_LOOKUP_MAX_ENTRIES && !oldest.done) {
      paymentMethodLookups.delete(oldest.value);
    }
  }
  paymentMethodLookups.set(stripeCustomerId, {
    hasPaymentMethod,
    expiresAt: Date.now() + PAYMENT_METHOD_LOOKUP_TTL_MS,
  });
}

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

  const cached = readCachedPaymentMethodLookup(stripeCustomerId);
  if (cached !== undefined) return cached;

  // This function may become redundant if our in-db administration is accurate.
  try {
    const paymentMethods = await client.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    });
    const hasPaymentMethod = paymentMethods.data.length > 0;
    writeCachedPaymentMethodLookup(stripeCustomerId, hasPaymentMethod);
    return hasPaymentMethod;
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
    writeCachedPaymentMethodLookup(stripeCustomerId, false);
    return false;
  }
}
