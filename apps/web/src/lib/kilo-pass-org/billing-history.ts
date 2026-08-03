import type Stripe from 'stripe';

const PAGE_SIZE = 25;

export async function listKiloPassOrganizationInvoices(input: {
  customerId: string;
  itemIds: ReadonlySet<string>;
  cursor?: string;
  listInvoices: (params: Stripe.InvoiceListParams) => Promise<{
    data: Stripe.Invoice[];
    has_more: boolean;
  }>;
}) {
  const matching: Stripe.Invoice[] = [];
  let startingAfter = input.cursor;
  let hasMore = false;
  let cursor: string | null = null;

  do {
    const page = await input.listInvoices({
      customer: input.customerId,
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    matching.push(
      ...page.data.filter(invoice =>
        invoice.lines.data.some(line => {
          const itemId = line.parent?.subscription_item_details?.subscription_item;
          return typeof itemId === 'string' && input.itemIds.has(itemId);
        })
      )
    );
    hasMore = page.has_more;
    cursor = page.data.at(-1)?.id ?? null;
    startingAfter = cursor ?? undefined;
  } while (matching.length < PAGE_SIZE && hasMore && cursor);

  return { invoices: matching, hasMore, cursor: hasMore ? cursor : null };
}
