import { getKiloClawCheckoutSuccessPhase } from './checkout-success-state';

describe('getKiloClawCheckoutSuccessPhase', () => {
  it('treats activationState as source of truth for activated subscriptions', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: {
          status: 'active',
          activationState: 'activated',
        },
        timedOut: false,
      })
    ).toBe('activated');
  });

  it('waits for settlement while Stripe-created row is still pending', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: {
          status: 'active',
          activationState: 'pending_settlement',
        },
        timedOut: false,
      })
    ).toBe('waiting_for_settlement');
  });

  it('waits for subscription creation before row exists', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: null,
        timedOut: false,
      })
    ).toBe('waiting_for_subscription');
  });

  it('shows timeout state when activation has not completed in time', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: {
          status: 'active',
          activationState: 'pending_settlement',
        },
        timedOut: true,
      })
    ).toBe('timed_out_waiting_for_settlement');
  });

  it('keeps activated state even after timeout flips true', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: {
          status: 'active',
          activationState: 'activated',
        },
        timedOut: true,
      })
    ).toBe('activated');
  });

  it('does not treat non-active activated rows as successful checkout', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: {
          status: 'canceled',
          activationState: 'activated',
        },
        timedOut: false,
      })
    ).toBe('waiting_for_subscription');
  });

  it('times out instead of showing success for non-active activated rows', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: {
          status: 'past_due',
          activationState: 'activated',
        },
        timedOut: true,
      })
    ).toBe('timed_out_waiting_for_subscription');
  });

  it('uses neutral timeout state when no subscription row ever appears', () => {
    expect(
      getKiloClawCheckoutSuccessPhase({
        subscription: null,
        timedOut: true,
      })
    ).toBe('timed_out_waiting_for_subscription');
  });
});
