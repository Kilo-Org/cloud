import type Stripe from 'stripe';

// Extended type for subscription with period properties
export type SubscriptionWithPeriod = Stripe.Subscription & {
  current_period_start?: number;
  current_period_end?: number;
  created: number;
  cancel_at?: number;
};

// Extended type for subscription item with period properties
export type SubscriptionItemWithPeriod = Stripe.SubscriptionItem & {
  current_period_start?: number;
  current_period_end?: number;
};
