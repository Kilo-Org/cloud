import {
  cancelStripeHostingImmediately,
  cancelKiloClawHostingImmediately,
  decideImmediateKiloClawCancellation,
} from './immediate-cancellation';

describe('decideImmediateKiloClawCancellation', () => {
  it.each(['active', 'past_due', 'unpaid', 'trialing'] as const)(
    'cancels current %s subscriptions',
    status => {
      expect(
        decideImmediateKiloClawCancellation({
          status,
          transferredToSubscriptionId: null,
          pendingConversion: false,
        })
      ).toBe('cancel');
    }
  );

  it('does not cancel terminal or transferred subscription history', () => {
    expect(
      decideImmediateKiloClawCancellation({
        status: 'canceled',
        transferredToSubscriptionId: null,
        pendingConversion: false,
      })
    ).toBe('not_needed');
    expect(
      decideImmediateKiloClawCancellation({
        status: 'active',
        transferredToSubscriptionId: '11111111-1111-4111-8111-111111111111',
        pendingConversion: false,
      })
    ).toBe('not_needed');
  });

  it('cleans up cancellation state when a canceled row still has a pending conversion', () => {
    expect(
      decideImmediateKiloClawCancellation({
        status: 'canceled',
        transferredToSubscriptionId: null,
        pendingConversion: true,
      })
    ).toBe('cancel');
  });
});

describe('cancelKiloClawHostingImmediately', () => {
  function dependencies() {
    return {
      prepare: jest.fn().mockResolvedValue({
        subscription: {
          id: 'local-subscription',
          status: 'active',
          transferred_to_subscription_id: null,
          pending_conversion: false,
          stripe_subscription_id: 'sub_hosting',
          stripe_schedule_id: null,
        },
        clearedPendingConversion: false,
      }),
      cancelStripe: jest.fn().mockResolvedValue('canceled'),
      reconcile: jest.fn().mockResolvedValue(true),
    };
  }

  it('reconciles local state even when Stripe was already canceled', async () => {
    const deps = dependencies();
    deps.cancelStripe.mockResolvedValue('not_needed');
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({
      status: 'canceled',
      subscriptionIds: ['local-subscription'],
    });
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('retries database reconciliation after an earlier successful Stripe cancellation', async () => {
    const deps = dependencies();
    deps.reconcile.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({
      status: 'failed',
      error: 'database unavailable',
    });
    deps.cancelStripe.mockResolvedValue('not_needed');
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({
      status: 'canceled',
      subscriptionIds: ['local-subscription'],
    });
    expect(deps.reconcile).toHaveBeenCalledTimes(2);
  });

  it('verifies upstream billing even when the local row is canceled', async () => {
    const deps = dependencies();
    const prepared = await deps.prepare();
    deps.prepare.mockResolvedValue({
      ...prepared,
      subscription: { ...prepared.subscription, status: 'canceled' },
    });
    deps.reconcile.mockResolvedValue(false);
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({
      status: 'canceled',
      subscriptionIds: ['local-subscription'],
    });
    expect(deps.cancelStripe).toHaveBeenCalledWith('sub_hosting', null);
  });

  it('does not mutate transferred subscriptions even when they retain a Stripe reference', async () => {
    const deps = dependencies();
    const prepared = await deps.prepare();
    deps.prepare.mockResolvedValue({
      ...prepared,
      subscription: { ...prepared.subscription, transferred_to_subscription_id: 'successor' },
    });
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({ status: 'not_needed' });
    expect(deps.cancelStripe).not.toHaveBeenCalled();
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it('cancels pure-credit hosting locally without calling Stripe', async () => {
    const deps = dependencies();
    const prepared = await deps.prepare();
    deps.prepare.mockResolvedValue({
      ...prepared,
      subscription: { ...prepared.subscription, stripe_subscription_id: null },
    });
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({
      status: 'canceled',
      subscriptionIds: ['local-subscription'],
    });
    expect(deps.cancelStripe).not.toHaveBeenCalled();
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not cancel detached or already-terminal pure-credit subscriptions', async () => {
    const deps = dependencies();
    const prepared = await deps.prepare();
    deps.prepare.mockResolvedValueOnce({ subscription: null, clearedPendingConversion: false });
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({ status: 'not_needed' });
    deps.prepare.mockResolvedValueOnce({
      subscription: { ...prepared.subscription, status: 'canceled', stripe_subscription_id: null },
      clearedPendingConversion: false,
    });
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({ status: 'not_needed' });
    expect(deps.cancelStripe).not.toHaveBeenCalled();
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it('finishes preparing conversion cancellation before calling Stripe', async () => {
    const deps = dependencies();
    const prepared = await deps.prepare();
    let conversionCleared = false;
    deps.prepare.mockImplementation(async () => {
      await Promise.resolve();
      conversionCleared = true;
      return { ...prepared, clearedPendingConversion: true };
    });
    deps.cancelStripe.mockImplementation(async () => {
      expect(conversionCleared).toBe(true);
      return 'not_needed';
    });
    deps.reconcile.mockResolvedValue(false);
    await expect(cancelKiloClawHostingImmediately(deps)).resolves.toEqual({
      status: 'canceled',
      subscriptionIds: ['local-subscription'],
    });
  });

  it('reports preparation and provider failures without claiming cancellation', async () => {
    const preparationFailure = dependencies();
    preparationFailure.prepare.mockRejectedValue(new Error('database unavailable'));
    await expect(cancelKiloClawHostingImmediately(preparationFailure)).resolves.toEqual({
      status: 'failed',
      error: 'database unavailable',
    });
    expect(preparationFailure.cancelStripe).not.toHaveBeenCalled();
    const providerFailure = dependencies();
    providerFailure.cancelStripe.mockRejectedValue(new Error('Stripe unavailable'));
    await expect(cancelKiloClawHostingImmediately(providerFailure)).resolves.toEqual({
      status: 'failed',
      error: 'Stripe unavailable',
    });
    expect(providerFailure.reconcile).not.toHaveBeenCalled();
  });
});

describe('cancelStripeHostingImmediately', () => {
  function dependencies(subscription: {
    status: string;
    schedule: string | { id: string } | null;
  }) {
    return {
      retrieve: jest.fn().mockResolvedValue(subscription),
      releaseSchedule: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue({}),
      isInactiveScheduleError: jest.fn().mockReturnValue(false),
    };
  }

  it('cancels active Stripe and hybrid hosting without invoices or proration', async () => {
    const deps = dependencies({ status: 'active', schedule: null });

    await expect(
      cancelStripeHostingImmediately({
        stripeSubscriptionId: 'sub_hybrid',
        storedScheduleId: null,
        ...deps,
      })
    ).resolves.toBe('canceled');

    expect(deps.cancel).toHaveBeenCalledWith('sub_hybrid', { prorate: false, invoice_now: false });
  });

  it('does not cancel an upstream-canceled subscription', async () => {
    const deps = dependencies({ status: 'canceled', schedule: 'sched_unused' });

    await expect(
      cancelStripeHostingImmediately({
        stripeSubscriptionId: 'sub_canceled',
        storedScheduleId: null,
        ...deps,
      })
    ).resolves.toBe('not_needed');

    expect(deps.releaseSchedule).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('prefers the live schedule over a stale stored schedule before cancellation', async () => {
    const deps = dependencies({ status: 'active', schedule: 'sched_live' });

    await cancelStripeHostingImmediately({
      stripeSubscriptionId: 'sub_schedule',
      storedScheduleId: 'sched_stored',
      ...deps,
    });

    expect(deps.releaseSchedule).toHaveBeenCalledWith('sched_live');
    expect(deps.releaseSchedule.mock.invocationCallOrder[0]).toBeLessThan(
      deps.cancel.mock.invocationCallOrder[0]
    );
  });

  it('uses a stored schedule when the provider has no current schedule reference', async () => {
    const deps = dependencies({ status: 'active', schedule: null });
    await cancelStripeHostingImmediately({
      stripeSubscriptionId: 'sub_schedule',
      storedScheduleId: 'sched_stored',
      ...deps,
    });
    expect(deps.releaseSchedule).toHaveBeenCalledWith('sched_stored');
  });

  it('accepts provider-confirmed concurrent cancellation', async () => {
    const deps = dependencies({ status: 'active', schedule: null });
    deps.cancel.mockRejectedValue(new Error('request interrupted'));
    deps.retrieve.mockResolvedValueOnce({ status: 'active', schedule: null });
    deps.retrieve.mockResolvedValueOnce({ status: 'canceled', schedule: null });
    await expect(
      cancelStripeHostingImmediately({
        stripeSubscriptionId: 'sub_hosting',
        storedScheduleId: null,
        ...deps,
      })
    ).resolves.toBe('canceled');
    expect(deps.retrieve).toHaveBeenCalledTimes(2);
  });

  it('preserves a cancellation error when verifying provider state also fails', async () => {
    const deps = dependencies({ status: 'active', schedule: null });
    deps.cancel.mockRejectedValue(new Error('cancellation unavailable'));
    deps.retrieve.mockResolvedValueOnce({ status: 'active', schedule: null });
    deps.retrieve.mockRejectedValueOnce(new Error('verification unavailable'));
    await expect(
      cancelStripeHostingImmediately({
        stripeSubscriptionId: 'sub_hosting',
        storedScheduleId: null,
        ...deps,
      })
    ).rejects.toThrow('cancellation unavailable');
  });

  it('discovers and releases a live schedule when no stored schedule exists', async () => {
    const deps = dependencies({ status: 'active', schedule: 'sched_live' });

    await cancelStripeHostingImmediately({
      stripeSubscriptionId: 'sub_schedule',
      storedScheduleId: null,
      ...deps,
    });

    expect(deps.releaseSchedule).toHaveBeenCalledWith('sched_live');
  });

  it('stops when schedule release or provider cancellation fails', async () => {
    const scheduleFailure = dependencies({ status: 'active', schedule: 'sched_live' });
    scheduleFailure.releaseSchedule.mockRejectedValueOnce(new Error('schedule failure'));
    await expect(
      cancelStripeHostingImmediately({
        stripeSubscriptionId: 'sub_schedule',
        storedScheduleId: null,
        ...scheduleFailure,
      })
    ).rejects.toThrow('schedule failure');
    expect(scheduleFailure.cancel).not.toHaveBeenCalled();

    const cancelFailure = dependencies({ status: 'active', schedule: null });
    cancelFailure.cancel.mockRejectedValueOnce(new Error('provider failure'));
    await expect(
      cancelStripeHostingImmediately({
        stripeSubscriptionId: 'sub_provider',
        storedScheduleId: null,
        ...cancelFailure,
      })
    ).rejects.toThrow('provider failure');
  });
});
