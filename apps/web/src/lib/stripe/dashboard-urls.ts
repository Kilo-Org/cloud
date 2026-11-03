function stripeDashboardPrefix(): string {
  return process.env.NODE_ENV === 'development' ? 'test/' : '';
}

export function stripePaymentUrl(chargeId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}payments/${chargeId}`;
}

export function stripeCustomerUrl(customerId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}customers/${customerId}`;
}

export function stripeDisputeUrl(disputeId: string): string {
  return `https://dashboard.stripe.com/${stripeDashboardPrefix()}disputes/${disputeId}`;
}
