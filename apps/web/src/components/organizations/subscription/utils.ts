import type Stripe from 'stripe';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

// Module-level formatting functions
export const formatDate = (timestamp: number) => {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

export const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount / 100); // Stripe amounts are in cents
};

/** True for roles that may manage billing (owner or billing_manager). */
export function canManageBilling(role: OrganizationRole | string): boolean {
  return role === 'owner' || role === 'billing_manager';
}

/** Find the paid seat item in a subscription (unit_amount > 0). */
export function findPaidSeatItem(
  items: Stripe.SubscriptionItem[]
): Stripe.SubscriptionItem | undefined {
  return items.find(item => (item.price?.unit_amount ?? 0) > 0);
}

/** Sum paid seat quantities across subscription items (unit_amount > 0). */
export function paidSeatQuantity(items: Stripe.SubscriptionItem[]): number {
  return items
    .filter(item => (item.price?.unit_amount ?? 0) > 0)
    .reduce((total, item) => total + (item.quantity ?? 0), 0);
}
