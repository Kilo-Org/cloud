import 'server-only';

import type Stripe from 'stripe';

const COLLECTIBLE_INVOICE_STATUSES = ['open', 'draft'] as const;
const ALREADY_ABANDONED_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  'void',
  'paid',
  'uncollectible',
]);

export type StripeCollectibleInvoiceClient = {
  invoices: {
    list: (
      params: Stripe.InvoiceListParams
    ) => PromiseLike<Pick<Stripe.ApiList<Stripe.Invoice>, 'data' | 'has_more'>>;
    voidInvoice: (invoiceId: string) => Promise<unknown>;
    del: (invoiceId: string) => Promise<unknown>;
    retrieve: (invoiceId: string) => PromiseLike<Pick<Stripe.Invoice, 'status'>>;
  };
};

function isStripeResourceMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'resource_missing'
  );
}

async function listInvoicesByStatus(params: {
  stripe: StripeCollectibleInvoiceClient;
  stripeSubscriptionId: string;
  status: (typeof COLLECTIBLE_INVOICE_STATUSES)[number];
}): Promise<Stripe.Invoice[]> {
  const invoices: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await params.stripe.invoices.list({
      subscription: params.stripeSubscriptionId,
      status: params.status,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    invoices.push(...page.data);
    const lastInvoice = page.data.at(-1);
    startingAfter = page.has_more && lastInvoice?.id ? lastInvoice.id : undefined;
  } while (startingAfter);

  return invoices;
}

async function ignoreIfAlreadyAbandoned(params: {
  stripe: StripeCollectibleInvoiceClient;
  invoiceId: string;
  error: unknown;
}): Promise<void> {
  if (isStripeResourceMissing(params.error)) return;

  let status: Stripe.Invoice.Status | null | undefined;
  try {
    status = (await params.stripe.invoices.retrieve(params.invoiceId)).status;
  } catch (retrieveError) {
    if (isStripeResourceMissing(retrieveError)) return;
    throw params.error;
  }

  if (status != null && ALREADY_ABANDONED_INVOICE_STATUSES.has(status)) return;
  if (status === 'open') {
    await params.stripe.invoices.voidInvoice(params.invoiceId);
    return;
  }
  throw params.error;
}

async function abandonInvoice(params: {
  stripe: StripeCollectibleInvoiceClient;
  invoice: Pick<Stripe.Invoice, 'id' | 'status'>;
}): Promise<void> {
  const invoiceId = params.invoice.id;
  if (!invoiceId) return;

  try {
    if (params.invoice.status === 'draft') {
      await params.stripe.invoices.del(invoiceId);
      return;
    }
    await params.stripe.invoices.voidInvoice(invoiceId);
  } catch (error) {
    await ignoreIfAlreadyAbandoned({
      stripe: params.stripe,
      invoiceId,
      error,
    });
  }
}

export async function abandonCollectibleInvoicesForStripeSubscription(params: {
  stripe: StripeCollectibleInvoiceClient;
  stripeSubscriptionId: string;
}): Promise<void> {
  for (const status of COLLECTIBLE_INVOICE_STATUSES) {
    const invoices = await listInvoicesByStatus({
      stripe: params.stripe,
      stripeSubscriptionId: params.stripeSubscriptionId,
      status,
    });
    for (const invoice of invoices) {
      await abandonInvoice({ stripe: params.stripe, invoice });
    }
  }
}
