import { db } from '@/lib/drizzle';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { client as stripe } from '@/lib/stripe-client';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import type Stripe from 'stripe';

type CreateOrReuseKiloPassCheckoutSessionParams = {
  userId: string;
  stripeCustomerId: string;
  metadata: Stripe.MetadataParam;
  createSession: () => Promise<Stripe.Checkout.Session>;
};

const STRIPE_CHECKOUT_TIMEOUT_MS = 10_000;
const MAX_STRIPE_PAGES = 3;
const PRODUCT_METADATA_KEYS = [
  'tier',
  'cadence',
  'kiloclawHostingPlan',
  'kiloclawInstanceId',
  'kiloclawPriceVersion',
] as const;

export async function createOrReuseKiloPassCheckoutSession(
  params: CreateOrReuseKiloPassCheckoutSessionParams
): Promise<{ url: string | null }> {
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kilo-pass:checkout:${params.userId}`}, 0))`
    );

    const existing = await getKiloPassStateForUser(tx, params.userId);
    if (existing && !isStripeSubscriptionEnded(existing.status)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'You already have an active Kilo Pass subscription.',
      });
    }

    const isUserKiloPassSession = (session: Stripe.Checkout.Session) =>
      session.metadata?.type === 'kilo-pass' && session.metadata.kiloUserId === params.userId;
    const matchesRequestedProduct = (session: Stripe.Checkout.Session) =>
      PRODUCT_METADATA_KEYS.every(key => session.metadata?.[key] === params.metadata[key]);
    let checkoutCursor: string | undefined;
    let checkoutPageCount = 0;
    do {
      const openSessions = await stripe.checkout.sessions.list(
        {
          customer: params.stripeCustomerId,
          status: 'open',
          limit: 100,
          ...(checkoutCursor ? { starting_after: checkoutCursor } : {}),
        },
        { timeout: STRIPE_CHECKOUT_TIMEOUT_MS }
      );
      checkoutPageCount++;
      for (const session of openSessions.data.filter(isUserKiloPassSession)) {
        if (matchesRequestedProduct(session) && typeof session.url === 'string') {
          return { url: session.url };
        }
        await stripe.checkout.sessions.expire(session.id, {
          timeout: STRIPE_CHECKOUT_TIMEOUT_MS,
        });
      }
      checkoutCursor =
        openSessions.has_more && checkoutPageCount < MAX_STRIPE_PAGES
          ? openSessions.data.at(-1)?.id
          : undefined;
    } while (checkoutCursor);

    let subscriptionCursor: string | undefined;
    let hasLiveStripeSubscription = false;
    let subscriptionPageCount = 0;
    do {
      const subscriptions = await stripe.subscriptions.list(
        {
          customer: params.stripeCustomerId,
          status: 'all',
          limit: 100,
          ...(subscriptionCursor ? { starting_after: subscriptionCursor } : {}),
        },
        { timeout: STRIPE_CHECKOUT_TIMEOUT_MS }
      );
      subscriptionPageCount++;
      hasLiveStripeSubscription = subscriptions.data.some(
        subscription =>
          subscription.metadata.type === 'kilo-pass' &&
          subscription.metadata.kiloUserId === params.userId &&
          !isStripeSubscriptionEnded(subscription.status)
      );
      subscriptionCursor =
        !hasLiveStripeSubscription &&
        subscriptions.has_more &&
        subscriptionPageCount < MAX_STRIPE_PAGES
          ? subscriptions.data.at(-1)?.id
          : undefined;
    } while (subscriptionCursor);

    if (hasLiveStripeSubscription) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'You already have an active Kilo Pass subscription.',
      });
    }

    const session = await params.createSession();
    return { url: typeof session.url === 'string' ? session.url : null };
  });
}
