export function isStripeSubscriptionEnded(status: string): boolean {
  return status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired';
}
