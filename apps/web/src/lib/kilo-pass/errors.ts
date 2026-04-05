/**
 * Custom error class for Kilo Pass operations that includes
 * Stripe and Kilo Pass context for better Sentry visibility.
 */
export class KiloPassError extends Error {
  readonly stripe_event_id: string | null;
  readonly stripe_invoice_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly kilo_user_id: string | null;

  constructor(
    message: string,
    context: {
      stripe_event_id?: string | null;
      stripe_invoice_id?: string | null;
      stripe_subscription_id?: string | null;
      kilo_user_id?: string | null;
    } = {}
  ) {
    super(message);
    this.name = 'KiloPassError';
    this.stripe_event_id = context.stripe_event_id ?? null;
    this.stripe_invoice_id = context.stripe_invoice_id ?? null;
    this.stripe_subscription_id = context.stripe_subscription_id ?? null;
    this.kilo_user_id = context.kilo_user_id ?? null;
  }
}
