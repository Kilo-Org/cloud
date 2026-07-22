export class ContainerBillingError extends Error {
  constructor(
    readonly code: 'INSUFFICIENT_CREDITS' | 'BILLING_UNAVAILABLE',
    message: string,
    readonly details?: { remaining?: number; minimumRequired?: number }
  ) {
    super(message);
    this.name = 'ContainerBillingError';
  }
}
