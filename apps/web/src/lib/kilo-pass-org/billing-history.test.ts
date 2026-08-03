import { describe, expect, it, jest } from '@jest/globals';
import type Stripe from 'stripe';
import { listKiloPassOrganizationInvoices } from './billing-history';

function invoice(id: string, itemId: string) {
  return {
    id,
    lines: {
      data: [
        {
          parent: { subscription_item_details: { subscription_item: itemId } },
        },
      ],
    },
  } as Stripe.Invoice;
}

describe('organization Kilo Pass billing history', () => {
  it('omits seat-only invoices and scans subsequent pages for pass invoices', async () => {
    const listInvoices = jest
      .fn<
        (params: Stripe.InvoiceListParams) => Promise<{ data: Stripe.Invoice[]; has_more: boolean }>
      >()
      .mockResolvedValueOnce({ data: [invoice('in_seats', 'si_seats')], has_more: true })
      .mockResolvedValueOnce({ data: [invoice('in_pass', 'si_pass')], has_more: false });

    const result = await listKiloPassOrganizationInvoices({
      customerId: 'cus_1',
      itemIds: new Set(['si_pass']),
      listInvoices,
    });

    expect(result.invoices.map(entry => entry.id)).toEqual(['in_pass']);
    expect(result).toMatchObject({ hasMore: false, cursor: null });
    expect(listInvoices).toHaveBeenNthCalledWith(2, {
      customer: 'cus_1',
      limit: 25,
      starting_after: 'in_seats',
    });
  });
});
