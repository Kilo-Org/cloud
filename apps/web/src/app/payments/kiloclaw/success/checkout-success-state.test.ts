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
    ).toBe('timed_out');
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
});
