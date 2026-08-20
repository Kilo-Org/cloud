import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type Stripe from 'stripe';

import { client as stripe } from '@/lib/stripe-client';
import { retrieveStripeSubscriptionSnapshot } from '../../scripts/service-fees/kilo-pass-classification-audit';

function subscriptionItem(id: string): Stripe.SubscriptionItem {
  return {
    id,
    price: { id: `price_${id}`, product: `prod_${id}` },
  } as Stripe.SubscriptionItem;
}

function subscription(): Stripe.Subscription {
  return {
    id: 'sub_audit',
    status: 'active',
    metadata: {},
  } as Stripe.Subscription;
}

function itemPage(
  data: Stripe.SubscriptionItem[],
  hasMore: boolean
): Stripe.ApiList<Stripe.SubscriptionItem> {
  return {
    object: 'list',
    data,
    has_more: hasMore,
    url: '/v1/subscription_items',
  };
}

describe('retrieveStripeSubscriptionSnapshot', () => {
  const retrieve = jest.spyOn(stripe.subscriptions, 'retrieve');
  const list = jest.spyOn(stripe.subscriptionItems, 'list');

  beforeEach(() => {
    retrieve.mockReset();
    list.mockReset();
    retrieve.mockResolvedValue(subscription() as never);
  });

  test('requests up to 100 expanded subscription items', async () => {
    list.mockResolvedValue(itemPage([subscriptionItem('si_pass')], false) as never);

    await expect(retrieveStripeSubscriptionSnapshot('sub_audit')).resolves.toMatchObject({
      id: 'sub_audit',
      items: [{ id: 'si_pass', priceId: 'price_si_pass', productId: 'prod_si_pass' }],
    });
    expect(retrieve).toHaveBeenCalledWith('sub_audit');
    expect(list).toHaveBeenCalledWith({
      subscription: 'sub_audit',
      limit: 100,
      expand: ['data.price'],
    });
  });

  test('paginates instead of silently truncating subscription items', async () => {
    list
      .mockResolvedValueOnce(itemPage([subscriptionItem('si_1')], true) as never)
      .mockResolvedValueOnce(itemPage([subscriptionItem('si_2')], false) as never);

    await expect(retrieveStripeSubscriptionSnapshot('sub_audit')).resolves.toMatchObject({
      items: [{ id: 'si_1' }, { id: 'si_2' }],
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      subscription: 'sub_audit',
      limit: 100,
      expand: ['data.price'],
      starting_after: 'si_1',
    });
  });
});
