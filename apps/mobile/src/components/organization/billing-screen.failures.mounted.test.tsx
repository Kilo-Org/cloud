// Billing screen failure contract: a rejected read renders that block's error
// card with a Retry, and the Retry refetches only the query that failed — not
// its siblings. The query layer is mocked so each block's state is driven
// directly through the screen JSX.

import {
  handlerOf,
  mount,
  onlyButton,
  queries,
  reads,
  resetBillingQueries,
  subscriptionReadout,
  texts,
} from './billing-screen.test-helpers';
import { beforeEach, describe, expect, it } from 'vitest';

import { act } from '@/test/renderer';

beforeEach(() => {
  resetBillingQueries();
});

describe('OrganizationBillingScreen failure states', () => {
  it('offers Retry when the subscription read fails, and refetches only that read', async () => {
    queries.subscription.isError = true;
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain('Something went wrong');
    expect(copy).toContain('Retry');

    await act(() => {
      handlerOf(onlyButton(renderer), 'onPress')?.();
    });

    expect(queries.subscription.refetch).toHaveBeenCalledTimes(1);
    expect(queries.seats.refetch).not.toHaveBeenCalled();
    expect(queries.autoTopUp.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('offers Retry when the auto top-up read fails, and refetches only that read', async () => {
    queries.subscription.data = subscriptionReadout();
    queries.autoTopUp.isError = true;
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain('Retry');
    // The subscription block painted its card, so the only error card is the
    // auto top-up one, and its Retry asks that read again.
    expect(renderer.root.findAllByType('KvRow').length).toBeGreaterThan(0);

    await act(() => {
      handlerOf(onlyButton(renderer), 'onPress')?.();
    });

    expect(queries.autoTopUp.refetch).toHaveBeenCalledTimes(1);
    expect(queries.subscription.refetch).not.toHaveBeenCalled();
    expect(queries.seats.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('offers Retry when the Kilo Pass usage read fails, and refetches only that read', async () => {
    queries.subscription.data = subscriptionReadout();
    // An agreement puts the usage section on the screen; without one it stays
    // hidden, because the read alone cannot tell "no pass" from "no window".
    queries.kiloPass.data = {
      state: 'active',
      commercialState: 'active',
      processingCondition: 'ready',
      agreement: { tier: 'tier_49', paidSeatCount: 2, planVersion: 1, paidThrough: null },
    };
    queries.kiloPassUsage.isError = true;
    const { renderer, unmount } = await mount();

    const copy = texts(renderer);
    expect(copy).toContain('Something went wrong');
    expect(copy).toContain('Retry');

    await act(() => {
      handlerOf(onlyButton(renderer), 'onPress')?.();
    });

    expect(queries.kiloPassUsage.refetch).toHaveBeenCalledTimes(1);
    expect(queries.subscription.refetch).not.toHaveBeenCalled();
    expect(queries.autoTopUp.refetch).not.toHaveBeenCalled();
    expect(queries.kiloPass.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the Kilo Pass usage section off an agreement that has ended', async () => {
    queries.subscription.data = subscriptionReadout();
    // An ended agreement still answers a summary with an `agreement`, and the
    // usage read answers `null`. The section must stay off: there is no current
    // period to describe, and the web card renders nothing for it either.
    queries.kiloPass.data = {
      state: 'ended',
      commercialState: 'ended',
      processingCondition: 'ready',
      agreement: { tier: 'tier_49', paidSeatCount: 2, planVersion: 1, paidThrough: null },
    };
    const { renderer, unmount } = await mount();

    expect(reads.usageEnabled).toBe(false);
    expect(texts(renderer)).not.toContain('No monthly Credits have been issued yet.');
    unmount();
  });
});
