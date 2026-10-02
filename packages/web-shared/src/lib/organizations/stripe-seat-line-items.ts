import type Stripe from 'stripe';
import {
  STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID,
  STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID,
} from '@/lib/config.server';

export const SEAT_PRODUCT_IDS = new Set(
  [STRIPE_TEAMS_SUBSCRIPTION_PRODUCT_ID, STRIPE_ENTERPRISE_SUBSCRIPTION_PRODUCT_ID].filter(
    (productId): productId is string => productId != null && productId.trim() !== ''
  )
);

export function isSeatLineItem(item: Stripe.SubscriptionItem): boolean {
  const productId = item.price.product;
  return typeof productId === 'string' && SEAT_PRODUCT_IDS.has(productId);
}
