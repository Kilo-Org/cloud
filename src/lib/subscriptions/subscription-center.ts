import type Stripe from 'stripe';
import * as z from 'zod';
import { capitalize } from '@/lib/utils';

export const stripeBillingHistoryEntrySchema = z.object({
  kind: z.literal('stripe'),
  id: z.string(),
  date: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  invoiceUrl: z.string().nullable(),
  invoicePdfUrl: z.string().nullable(),
  description: z.string().nullable(),
});

export const creditsBillingHistoryEntrySchema = z.object({
  kind: z.literal('credits'),
  id: z.string(),
  date: z.string(),
  amountMicrodollars: z.number().int(),
  description: z.string(),
});

export const billingHistoryEntrySchema = z.union([
  stripeBillingHistoryEntrySchema,
  creditsBillingHistoryEntrySchema,
]);

export const billingHistoryResponseSchema = z.object({
  entries: z.array(billingHistoryEntrySchema),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});

export type StripeBillingHistoryEntry = z.infer<typeof stripeBillingHistoryEntrySchema>;
export type CreditsBillingHistoryEntry = z.infer<typeof creditsBillingHistoryEntrySchema>;
export type BillingHistoryEntry = z.infer<typeof billingHistoryEntrySchema>;

export function formatStoredPaymentMethodSummary(
  paymentMethod: {
    brand: string | null;
    last4: string | null;
  } | null
): string {
  if (!paymentMethod?.last4) {
    return 'Stripe';
  }

  const brand = paymentMethod.brand ? capitalize(paymentMethod.brand) : 'Card';
  return `${brand} ending in ${paymentMethod.last4}`;
}

export function mapStripeInvoiceToBillingHistoryEntry(
  invoice: Stripe.Invoice
): StripeBillingHistoryEntry {
  return {
    kind: 'stripe',
    id: invoice.id,
    date: new Date(invoice.created * 1000).toISOString(),
    amountCents: invoice.amount_due ?? 0,
    currency: invoice.currency ?? 'usd',
    status: invoice.status ?? 'unknown',
    invoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    description: invoice.lines.data[0]?.description ?? null,
  };
}
