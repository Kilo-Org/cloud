import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { showCancelFlow } from './loader';

describe('showCancelFlow', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('restarts the Churnkey flow so a previously completed session is not replayed', async () => {
    const init = jest.fn();
    Object.assign(globalThis, { window: { churnkey: { created: true, init } } });

    await showCancelFlow({
      authHash: 'hash',
      customerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      onCancel: async () => undefined,
    });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      'restart',
      expect.objectContaining({
        authHash: 'hash',
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
        provider: 'stripe',
      })
    );
  });
});
