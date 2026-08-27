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
  createSession: () => Promise<Stripe.Checkout.Session>;
};

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
    let checkoutCursor: string | undefined;
    do {
      const openSessions = await stripe.checkout.sessions.list({
        customer: params.stripeCustomerId,
        status: 'open',
        limit: 100,
        ...(checkoutCursor ? { starting_after: checkoutCursor } : {}),
      });
      const openKiloPassSession = openSessions.data.find(isUserKiloPassSession);
      if (typeof openKiloPassSession?.url === 'string') {
        return { url: openKiloPassSession.url };
      }
      checkoutCursor = openSessions.has_more ? openSessions.data.at(-1)?.id : undefined;
    } while (checkoutCursor);

    let subscriptionCursor: string | undefined;
    let hasLiveStripeSubscription = false;
    do {
      const subscriptions = await stripe.subscriptions.list({
        customer: params.stripeCustomerId,
        status: 'all',
        limit: 100,
        ...(subscriptionCursor ? { starting_after: subscriptionCursor } : {}),
      });
      hasLiveStripeSubscription = subscriptions.data.some(
        subscription =>
          subscription.metadata.type === 'kilo-pass' &&
          subscription.metadata.kiloUserId === params.userId &&
          !isStripeSubscriptionEnded(subscription.status)
      );
      subscriptionCursor =
        !hasLiveStripeSubscription && subscriptions.has_more
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
