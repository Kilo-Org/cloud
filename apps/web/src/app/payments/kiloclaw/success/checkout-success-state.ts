type CheckoutSuccessSubscription = {
  status: string;
  activationState: 'pending_settlement' | 'activated';
} | null;

export type KiloClawCheckoutSuccessPhase =
  | 'waiting_for_subscription'
  | 'waiting_for_settlement'
  | 'activated'
  | 'timed_out';

export function getKiloClawCheckoutSuccessPhase(params: {
  subscription: CheckoutSuccessSubscription | undefined;
  timedOut: boolean;
}): KiloClawCheckoutSuccessPhase {
  if (params.subscription?.activationState === 'activated') {
    return 'activated';
  }

  if (params.timedOut) {
    return 'timed_out';
  }

  if (
    params.subscription?.activationState === 'pending_settlement' ||
    params.subscription?.status === 'active'
  ) {
    return 'waiting_for_settlement';
  }

  return 'waiting_for_subscription';
}
