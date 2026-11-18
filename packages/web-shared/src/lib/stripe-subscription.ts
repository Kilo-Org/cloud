import type Stripe from 'stripe';

/**
 * A Stripe subscription as the API returns it.
 *
 * Declared in a workspace package so declaration bundles that expose it from an
 * inferred router type keep a nameable reference instead of inlining (and
 * degrading) the recursive Stripe structure.
 */
export type StripeSubscription = Stripe.Subscription;
