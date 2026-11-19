// Billing screen failure contract: a rejected read renders that block's error
// card with a Retry, and the Retry refetches only the query that failed — not
// its siblings. The query layer is mocked so each block's state is driven
// directly through the screen JSX.

import {
  handlerOf,
  mount,
  onlyButton,
  queries,
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
});
