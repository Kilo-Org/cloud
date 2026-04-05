import 'server-only';

import type Stripe from 'stripe';

import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';

function getInvoiceLinePriceIds(invoice: Stripe.Invoice): string[] {
  const ids: string[] = [];
  const lines = invoice.lines?.data ?? [];

  for (const line of lines) {
    const priceId = line.pricing?.price_details?.price ?? null;
    if (priceId) ids.push(priceId);
  }

  return ids;
}

/**
 * Strong Kilo Pass invoice classifier: match invoice line-item `price.id` against our known Kilo
 * Pass price IDs.
 */
export function invoiceLooksLikeKiloPassByPriceId(invoice: Stripe.Invoice): boolean {
  const invoiceLinePriceIds = getInvoiceLinePriceIds(invoice);
  if (invoiceLinePriceIds.length === 0) return false;

  const knownIds = getKnownStripePriceIdsForKiloPass();
  const knownIdSet = new Set(knownIds);

  return invoiceLinePriceIds.some(id => knownIdSet.has(id));
}
