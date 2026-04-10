import { describe, expect, test } from '@jest/globals';

import type { ShowCancelFlowParams } from '@/lib/churnkey/loader';

import {
  createKiloPassChurnkeyCancelFlow,
  type KiloPassChurnkeyAuth,
  type OpenKiloPassChurnkeyCancelFlowParams,
} from './kiloPassChurnkeyCancelFlow';

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  if (!resolvePromise || !rejectPromise) {
    throw new Error('Deferred promise callbacks were not initialized');
  }

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function getOnlyOpenedFlow(openedFlows: ShowCancelFlowParams[]): ShowCancelFlowParams {
  const openedFlow = openedFlows[0];
  if (!openedFlow) {
    throw new Error('Expected Churnkey flow to open');
  }
  return openedFlow;
}

function buildCancelFlowParams(overrides: Partial<OpenKiloPassChurnkeyCancelFlowParams> = {}): {
  params: OpenKiloPassChurnkeyCancelFlowParams;
  calls: {
    openedFlows: ShowCancelFlowParams[];
    directFallbackCancellations: string[];
    churnkeyCancellations: string[];
    stateInvalidations: string[];
    scheduledChangeInvalidations: string[];
    toasts: string[];
    errors: string[];
    confirmations: string[];
    inFlightChanges: boolean[];
    beforeOpen: string[];
  };
} {
  const openedFlows: ShowCancelFlowParams[] = [];
  const directFallbackCancellations: string[] = [];
  const churnkeyCancellations: string[] = [];
  const stateInvalidations: string[] = [];
  const scheduledChangeInvalidations: string[] = [];
  const toasts: string[] = [];
  const errors: string[] = [];
  const confirmations: string[] = [];
  const inFlightChanges: boolean[] = [];
  const beforeOpen: string[] = [];

  const params: OpenKiloPassChurnkeyCancelFlowParams = {
    stripeSubscriptionId: 'sub_test_current',
    getChurnkeyAuthHash: async () => ({ hash: 'hash_test', customerId: 'cus_test' }),
    showCancelFlow: async flowParams => {
      openedFlows.push(flowParams);
    },
    cancelSubscription: async () => {
      churnkeyCancellations.push('cancel');
    },
    invalidateKiloPassState: () => {
      stateInvalidations.push('state');
    },
    invalidateKiloPassScheduledChange: () => {
      scheduledChangeInvalidations.push('scheduled-change');
    },
    fallbackCancelSubscription: () => {
      directFallbackCancellations.push('fallback');
    },
    confirmFallbackCancel: message => {
      confirmations.push(message);
      return true;
    },
    notifyCancellationScheduled: () => {
      toasts.push('Cancellation scheduled');
    },
    notifyError: message => {
      errors.push(message);
    },
    onBeforeOpen: () => {
      beforeOpen.push('before-open');
    },
    onInFlightChange: value => {
      inFlightChanges.push(value);
    },
    ...overrides,
  };

  return {
    params,
    calls: {
      openedFlows,
      directFallbackCancellations,
      churnkeyCancellations,
      stateInvalidations,
      scheduledChangeInvalidations,
      toasts,
      errors,
      confirmations,
      inFlightChanges,
      beforeOpen,
    },
  };
}

describe('createKiloPassChurnkeyCancelFlow', () => {
  test('opens Churnkey with auth and cancels through the Kilo Pass mutation', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams();

    await coordinator.openCancelFlow(params);

    expect(calls.beforeOpen).toEqual(['before-open']);
    expect(calls.openedFlows).toHaveLength(1);
    const openedFlow = getOnlyOpenedFlow(calls.openedFlows);
    expect(openedFlow.authHash).toBe('hash_test');
    expect(openedFlow.customerId).toBe('cus_test');
    expect(openedFlow.stripeSubscriptionId).toBe('sub_test_current');

    await openedFlow.onCancel();

    expect(calls.churnkeyCancellations).toEqual(['cancel']);
    expect(calls.toasts).toEqual(['Cancellation scheduled']);
    expect(calls.stateInvalidations).toEqual(['state']);
    expect(calls.scheduledChangeInvalidations).toEqual(['scheduled-change']);

    openedFlow.onClose?.();
    expect(calls.stateInvalidations).toEqual(['state']);
    expect(calls.scheduledChangeInvalidations).toEqual(['scheduled-change']);
  });

  test('invalidates Kilo Pass queries when Churnkey closes without cancellation', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams();

    await coordinator.openCancelFlow(params);
    getOnlyOpenedFlow(calls.openedFlows).onClose?.();

    expect(calls.churnkeyCancellations).toHaveLength(0);
    expect(calls.stateInvalidations).toEqual(['state']);
    expect(calls.scheduledChangeInvalidations).toEqual(['scheduled-change']);
  });

  test('invalidates after a failed Churnkey cancellation without racing an in-flight cancel', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const deferredCancel = createDeferred<void>();
    const { params, calls } = buildCancelFlowParams({
      cancelSubscription: () => deferredCancel.promise,
    });

    await coordinator.openCancelFlow(params);
    const openedFlow = getOnlyOpenedFlow(calls.openedFlows);
    const cancelPromise = openedFlow.onCancel();

    openedFlow.onClose?.();
    expect(calls.stateInvalidations).toHaveLength(0);
    expect(calls.scheduledChangeInvalidations).toHaveLength(0);

    deferredCancel.reject(new Error('Stripe update failed'));
    await expect(cancelPromise).rejects.toThrow('Stripe update failed');

    expect(calls.stateInvalidations).toEqual(['state']);
    expect(calls.scheduledChangeInvalidations).toEqual(['scheduled-change']);
  });

  test('falls back to direct cancellation when auth hash fetch fails', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams({
      getChurnkeyAuthHash: async () => {
        throw new Error('CHURNKEY_API_SECRET is not configured');
      },
    });

    await coordinator.openCancelFlow(params);

    expect(calls.openedFlows).toHaveLength(0);
    expect(calls.errors).toEqual(['CHURNKEY_API_SECRET is not configured']);
    expect(calls.confirmations).toEqual([
      'Are you sure you want to cancel your Kilo Pass subscription?',
    ]);
    expect(calls.directFallbackCancellations).toEqual(['fallback']);
    expect(coordinator.getIsInFlight()).toBe(false);
  });

  test('falls back to direct cancellation when SDK loading or init fails', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams({
      showCancelFlow: async () => {
        throw new Error('Failed to load Churnkey SDK');
      },
    });

    await coordinator.openCancelFlow(params);

    expect(calls.errors).toEqual(['Failed to load Churnkey SDK']);
    expect(calls.directFallbackCancellations).toEqual(['fallback']);
    expect(coordinator.getIsInFlight()).toBe(false);
  });

  test('does not call direct cancellation when fallback confirmation is declined', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams({
      getChurnkeyAuthHash: async () => {
        throw new Error('auth unavailable');
      },
      confirmFallbackCancel: message => {
        calls.confirmations.push(message);
        return false;
      },
    });

    await coordinator.openCancelFlow(params);

    expect(calls.confirmations).toEqual([
      'Are you sure you want to cancel your Kilo Pass subscription?',
    ]);
    expect(calls.directFallbackCancellations).toHaveLength(0);
  });

  test('ignores duplicate opens synchronously while auth is in flight', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const deferredAuth = createDeferred<KiloPassChurnkeyAuth>();
    let authFetches = 0;
    const { params } = buildCancelFlowParams({
      getChurnkeyAuthHash: () => {
        authFetches += 1;
        return deferredAuth.promise;
      },
    });

    const firstOpen = coordinator.openCancelFlow(params);
    const duplicateOpen = coordinator.openCancelFlow(params);

    expect(authFetches).toBe(1);
    expect(coordinator.getIsInFlight()).toBe(true);

    deferredAuth.resolve({ hash: 'hash_test', customerId: 'cus_test' });
    await firstOpen;
    await duplicateOpen;
  });

  test('ignores duplicate opens from separate surfaces sharing one coordinator', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const deferredAuth = createDeferred<KiloPassChurnkeyAuth>();
    let authFetches = 0;
    const firstSurface = buildCancelFlowParams({
      getChurnkeyAuthHash: () => {
        authFetches += 1;
        return deferredAuth.promise;
      },
    });
    const secondSurface = buildCancelFlowParams({
      getChurnkeyAuthHash: async () => {
        authFetches += 1;
        return { hash: 'second_hash', customerId: 'second_customer' };
      },
    });

    const firstOpen = coordinator.openCancelFlow(firstSurface.params);
    const duplicateOpen = coordinator.openCancelFlow(secondSurface.params);

    expect(authFetches).toBe(1);
    expect(firstSurface.calls.inFlightChanges).toEqual([true]);
    expect(secondSurface.calls.inFlightChanges).toHaveLength(0);

    deferredAuth.resolve({ hash: 'hash_test', customerId: 'cus_test' });
    await firstOpen;
    await duplicateOpen;

    expect(firstSurface.calls.openedFlows).toHaveLength(1);
    expect(secondSurface.calls.openedFlows).toHaveLength(0);
  });

  test('keeps duplicate opens blocked after Churnkey init until onClose fires', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams();

    await coordinator.openCancelFlow(params);
    await coordinator.openCancelFlow(params);

    expect(calls.openedFlows).toHaveLength(1);
    expect(coordinator.getIsInFlight()).toBe(true);
  });

  test('allows opening again after Churnkey onClose clears the in-flight guard', async () => {
    const coordinator = createKiloPassChurnkeyCancelFlow();
    const { params, calls } = buildCancelFlowParams();

    await coordinator.openCancelFlow(params);
    getOnlyOpenedFlow(calls.openedFlows).onClose?.();
    await coordinator.openCancelFlow(params);

    expect(calls.openedFlows).toHaveLength(2);
    expect(coordinator.getIsInFlight()).toBe(true);
  });
});
