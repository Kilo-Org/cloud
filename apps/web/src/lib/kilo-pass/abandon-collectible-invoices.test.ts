import { describe, expect, it, jest } from '@jest/globals';
import type Stripe from 'stripe';

import {
  abandonCollectibleInvoicesForStripeSubscription,
  type StripeCollectibleInvoiceClient,
} from './abandon-collectible-invoices';

type InvoiceStatus = NonNullable<Stripe.Invoice['status']>;

type InvoicePage = {
  data: Array<{ id: string; status: InvoiceStatus }>;
  has_more: boolean;
};

function createStripeInvoiceClient(): StripeCollectibleInvoiceClient & {
  invoices: {
    list: jest.MockedFunction<StripeCollectibleInvoiceClient['invoices']['list']>;
    update: jest.MockedFunction<StripeCollectibleInvoiceClient['invoices']['update']>;
    voidInvoice: jest.MockedFunction<StripeCollectibleInvoiceClient['invoices']['voidInvoice']>;
    retrieve: jest.MockedFunction<StripeCollectibleInvoiceClient['invoices']['retrieve']>;
  };
} {
  return {
    invoices: {
      list: jest.fn<StripeCollectibleInvoiceClient['invoices']['list']>(),
      update: jest.fn<StripeCollectibleInvoiceClient['invoices']['update']>(),
      voidInvoice: jest.fn<StripeCollectibleInvoiceClient['invoices']['voidInvoice']>(),
      retrieve: jest.fn<StripeCollectibleInvoiceClient['invoices']['retrieve']>(),
    },
  };
}

describe('abandonCollectibleInvoicesForStripeSubscription', () => {
  it('voids open invoices and disables auto-advance on draft invoices for the subscription', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async params => {
      if (params.status === 'open') {
        return {
          data: [
            { id: 'in_open_1', status: 'open' },
            { id: 'in_open_2', status: 'open' },
          ],
          has_more: false,
        } satisfies InvoicePage;
      }
      if (params.status === 'draft') {
        return {
          data: [{ id: 'in_draft_1', status: 'draft' }],
          has_more: false,
        } satisfies InvoicePage;
      }
      return { data: [], has_more: false } satisfies InvoicePage;
    });
    stripe.invoices.update.mockResolvedValue({});
    stripe.invoices.voidInvoice.mockResolvedValue({});

    await abandonCollectibleInvoicesForStripeSubscription({
      stripe,
      stripeSubscriptionId: 'sub_kilo_pass',
    });

    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_kilo_pass',
      status: 'open',
      limit: 100,
    });
    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_kilo_pass',
      status: 'draft',
      limit: 100,
    });
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith('in_open_1');
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith('in_open_2');
    expect(stripe.invoices.update).toHaveBeenCalledWith('in_draft_1', { auto_advance: false });
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalledWith('in_draft_1');
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
  });

  it('pages through collectible invoices', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async params => {
      if (params.status === 'open' && params.starting_after == null) {
        return {
          data: [{ id: 'in_open_page_1', status: 'open' }],
          has_more: true,
        } satisfies InvoicePage;
      }
      if (params.status === 'open' && params.starting_after === 'in_open_page_1') {
        return {
          data: [{ id: 'in_open_page_2', status: 'open' }],
          has_more: false,
        } satisfies InvoicePage;
      }
      return { data: [], has_more: false } satisfies InvoicePage;
    });
    stripe.invoices.voidInvoice.mockResolvedValue({});

    await abandonCollectibleInvoicesForStripeSubscription({
      stripe,
      stripeSubscriptionId: 'sub_paged',
    });

    expect(stripe.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_paged',
      status: 'open',
      limit: 100,
      starting_after: 'in_open_page_1',
    });
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith('in_open_page_1');
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith('in_open_page_2');
  });

  it('ignores invoices that are already paid, void, or missing', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async params => {
      if (params.status === 'open') {
        return {
          data: [
            { id: 'in_paid_race', status: 'open' },
            { id: 'in_already_void', status: 'open' },
            { id: 'in_missing', status: 'open' },
          ],
          has_more: false,
        } satisfies InvoicePage;
      }
      return { data: [], has_more: false } satisfies InvoicePage;
    });
    stripe.invoices.voidInvoice.mockImplementation(async (invoiceId: string) => {
      if (invoiceId === 'in_missing') {
        throw { code: 'resource_missing' };
      }
      throw new Error('invoice cannot be voided');
    });
    stripe.invoices.retrieve.mockImplementation(async (invoiceId: string) => {
      if (invoiceId === 'in_paid_race') return { status: 'paid' };
      if (invoiceId === 'in_already_void') return { status: 'void' };
      throw { code: 'resource_missing' };
    });

    await abandonCollectibleInvoicesForStripeSubscription({
      stripe,
      stripeSubscriptionId: 'sub_races',
    });
  });

  it('voids a listed draft that is already open when auto-advance cannot be disabled', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async params => {
      if (params.status === 'draft') {
        return {
          data: [{ id: 'in_draft_raced_open', status: 'draft' }],
          has_more: false,
        } satisfies InvoicePage;
      }
      return { data: [], has_more: false } satisfies InvoicePage;
    });
    stripe.invoices.update.mockRejectedValue(new Error('invoice already finalized'));
    stripe.invoices.retrieve.mockResolvedValue({ status: 'open' });
    stripe.invoices.voidInvoice.mockResolvedValue({});

    await abandonCollectibleInvoicesForStripeSubscription({
      stripe,
      stripeSubscriptionId: 'sub_draft_race',
    });

    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith('in_draft_raced_open');
  });

  it('rethrows unexpected void failures', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async params => {
      if (params.status === 'open') {
        return {
          data: [{ id: 'in_open_fail', status: 'open' }],
          has_more: false,
        } satisfies InvoicePage;
      }
      return { data: [], has_more: false } satisfies InvoicePage;
    });
    stripe.invoices.voidInvoice.mockRejectedValue(new Error('stripe down'));
    stripe.invoices.retrieve.mockResolvedValue({ status: 'open' });

    await expect(
      abandonCollectibleInvoicesForStripeSubscription({
        stripe,
        stripeSubscriptionId: 'sub_fail',
      })
    ).rejects.toThrow('stripe down');
  });
});
