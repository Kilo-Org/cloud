import type Stripe from 'stripe';
import * as z from 'zod';
import { capitalize } from '@/lib/utils';
import { getKiloPassPriceMetadataForId } from '@kilocode/web-shared/lib/kilo-pass/stripe-price-ids.server';
import { isServiceFeeInvoiceLine } from '@kilocode/web-shared/lib/service-fees/stripe-lines';

export const stripeBillingHistoryLineSchema = z.object({
  // The tier values stay inline rather than the KiloPassTier enum: the mobile
  // app consumes this wire type without @kilocode/db, whose enum import would
  // drag server-only types into the client bundle.
  kind: z.enum(['trial', 'initial', 'renewal', 'upgrade', 'unknown']),
  tier: z.enum(['tier_19', 'tier_49', 'tier_199']).nullable(),
});

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
  /**
   * The invoice line typed for the reader, present only where the producing
   * router classifies it. Kilo Pass rows carry it; the other routers' rows
   * omit the key, so their wire shapes stay unchanged.
   */
  line: stripeBillingHistoryLineSchema.optional().nullable(),
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

/**
 * The invoice line typed for a Kilo Pass reader, or null when the invoice has
 * no line to classify.
 *
 * The kind comes from the billing reason, with the $0 first invoice read as the
 * trial it is; the tier comes from the line's known Kilo Pass price id. Service
 * fee lines say nothing about the plan, so the first non-fee line wins.
 */
export function mapKiloPassInvoiceLine(
  invoice: Stripe.Invoice
): NonNullable<StripeBillingHistoryEntry['line']> | null {
  const lines = invoice.lines?.data ?? [];
  const line = lines.find(candidate => !isServiceFeeInvoiceLine(candidate));
  if (!line) return null;

  const tier = getKiloPassPriceMetadataForId(line.pricing?.price_details?.price)?.tier ?? null;

  return { kind: getInvoiceLineKind(invoice), tier };
}

function getInvoiceLineKind(
  invoice: Stripe.Invoice
): NonNullable<StripeBillingHistoryEntry['line']>['kind'] {
  switch (invoice.billing_reason) {
    case 'subscription_create':
      return (invoice.amount_due ?? 0) === 0 ? 'trial' : 'initial';
    case 'subscription_cycle':
      return 'renewal';
    case 'subscription_update':
      return 'upgrade';
    default:
      return 'unknown';
  }
}
