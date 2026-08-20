import { describe, expect, it, jest } from '@jest/globals';

import { abandonCollectibleInvoicesForStripeSubscription } from './abandon-collectible-invoices';

type InvoicePage = {
  data: Array<{ id: string; status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' }>;
  has_more: boolean;
};

function createStripeInvoiceClient() {
  return {
    invoices: {
      list: jest.fn<
        (params: { status?: string; starting_after?: string }) => Promise<InvoicePage>
      >(),
      voidInvoice: jest.fn<(invoiceId: string) => Promise<unknown>>(),
      del: jest.fn<(invoiceId: string) => Promise<unknown>>(),
      retrieve:
        jest.fn<
          (invoiceId: string) => Promise<{ status: InvoicePage['data'][number]['status'] }>
        >(),
    },
  };
}

describe('abandonCollectibleInvoicesForStripeSubscription', () => {
  it('voids open invoices and deletes draft invoices for the subscription', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async (params: { status?: string }) => {
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
    stripe.invoices.voidInvoice.mockResolvedValue({});
    stripe.invoices.del.mockResolvedValue({});

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
    expect(stripe.invoices.del).toHaveBeenCalledWith('in_draft_1');
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
  });

  it('pages through collectible invoices', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(
      async (params: { status?: string; starting_after?: string }) => {
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
      }
    );
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
    stripe.invoices.list.mockImplementation(async (params: { status?: string }) => {
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

  it('rethrows unexpected void failures', async () => {
    const stripe = createStripeInvoiceClient();
    stripe.invoices.list.mockImplementation(async (params: { status?: string }) => {
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
