// Source of truth for Stripe subscription statuses surfaced in the admin
// organizations table. Used to (a) populate the Stripe Status filter dropdown,
// (b) render the per-row status badge, and (c) constrain the admin list router
// input so the three layers cannot drift independently.

export const STRIPE_SUBSCRIPTION_STATUSES = [
  { value: 'active', label: 'Active', style: 'bg-green-100 text-green-800' },
  { value: 'past_due', label: 'Past due', style: 'bg-yellow-100 text-yellow-800' },
  { value: 'canceled', label: 'Canceled', style: 'bg-red-100 text-red-800' },
  { value: 'ended', label: 'Ended', style: 'bg-gray-100 text-gray-700' },
  { value: 'incomplete', label: 'Incomplete', style: 'bg-orange-100 text-orange-800' },
  { value: 'incomplete_expired', label: 'Incomplete expired', style: 'bg-red-100 text-red-700' },
  { value: 'trialing', label: 'Trialing', style: 'bg-blue-100 text-blue-800' },
  { value: 'unpaid', label: 'Unpaid', style: 'bg-red-100 text-red-800' },
  { value: 'paused', label: 'Paused', style: 'bg-purple-100 text-purple-800' },
] as const;

export type StripeSubscriptionStatusValue = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number]['value'];

export const STRIPE_SUBSCRIPTION_STATUS_VALUES = STRIPE_SUBSCRIPTION_STATUSES.map(
  s => s.value
) as readonly StripeSubscriptionStatusValue[];

const stripeStatusByValue = new Map<string, (typeof STRIPE_SUBSCRIPTION_STATUSES)[number]>(
  STRIPE_SUBSCRIPTION_STATUSES.map(s => [s.value, s])
);

export function getStripeStatusLabel(value: string): string {
  return stripeStatusByValue.get(value)?.label ?? value.replace(/_/g, ' ');
}

export function getStripeStatusStyle(value: string): string {
  return stripeStatusByValue.get(value)?.style ?? 'bg-gray-100 text-gray-700';
}
