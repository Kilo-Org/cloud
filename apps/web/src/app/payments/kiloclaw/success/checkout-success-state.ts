type CheckoutSuccessSubscription = {
  status: string;
  activationState: 'pending_settlement' | 'activated';
} | null;

export type KiloClawCheckoutSuccessPhase =
  | 'waiting_for_subscription'
  | 'waiting_for_settlement'
  | 'activated'
  | 'timed_out_waiting_for_subscription'
  | 'timed_out_waiting_for_settlement';

export function getKiloClawCheckoutSuccessPhase(params: {
  subscription: CheckoutSuccessSubscription | undefined;
  timedOut: boolean;
}): KiloClawCheckoutSuccessPhase {
  const isActiveSubscription = params.subscription?.status === 'active';

  if (isActiveSubscription && params.subscription?.activationState === 'activated') {
    return 'activated';
  }

  if (params.timedOut) {
    return isActiveSubscription
      ? 'timed_out_waiting_for_settlement'
      : 'timed_out_waiting_for_subscription';
  }

  if (isActiveSubscription) {
    return 'waiting_for_settlement';
  }

  return 'waiting_for_subscription';
}
