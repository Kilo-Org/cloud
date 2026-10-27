import type Stripe from 'stripe';

// The overview card renders these fields only. Declaring the view as a pick of
// the API object keeps the wire type narrow enough to cross the tRPC
// declaration bundle, which cannot name the recursive Stripe account graph.
export type SubscriptionWithPeriod = Pick<
  Stripe.Subscription,
  | 'id'
  | 'status'
  | 'cancel_at'
  | 'cancel_at_period_end'
  | 'collection_method'
  | 'created'
  | 'ended_at'
  | 'items'
  | 'schedule'
> & {
  current_period_start?: number;
  current_period_end?: number;
};

// Extended type for subscription item with period properties
export type SubscriptionItemWithPeriod = Stripe.SubscriptionItem & {
  current_period_start?: number;
  current_period_end?: number;
};
