import 'server-only';

import type Stripe from 'stripe';

import { getKnownStripePriceIdsForKiloClaw } from '@/lib/kiloclaw/stripe-price-ids.server';

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
 * Match invoice line-item price IDs against known KiloClaw price IDs.
 *
 * Returns false (rather than throwing) when KiloClaw price env vars are
 * not configured, so unrelated invoice webhooks are not disrupted.
 */
export function invoiceLooksLikeKiloClawByPriceId(invoice: Stripe.Invoice): boolean {
  const invoiceLinePriceIds = getInvoiceLinePriceIds(invoice);
  if (invoiceLinePriceIds.length === 0) return false;

  let knownIds: readonly string[];
  try {
    knownIds = getKnownStripePriceIdsForKiloClaw();
  } catch {
    // KiloClaw env vars not configured — this invoice can't be KiloClaw.
    return false;
  }
  const knownIdSet = new Set(knownIds);

  return invoiceLinePriceIds.some(id => knownIdSet.has(id));
}
