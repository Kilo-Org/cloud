import 'server-only';

import type Stripe from 'stripe';

import {
  getKnownStripePriceIdsForKiloClaw,
  getStripePriceIdMetadata,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import type { KiloClawPriceVersion } from '@kilocode/db';

type KiloClawInvoiceLineClassification = {
  priceId: string;
  plan: 'commit' | 'standard';
  priceVersion: KiloClawPriceVersion;
  isIntro: boolean;
  periodStartUnix: number | null;
  periodEndUnix: number | null;
};

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
 * Returns null (rather than throwing) when KiloClaw price env vars are
 * not configured, so unrelated invoice webhooks are not disrupted.
 */
export function classifyKiloClawInvoiceLine(
  invoice: Stripe.Invoice
): KiloClawInvoiceLineClassification | null {
  const invoiceLinePriceIds = getInvoiceLinePriceIds(invoice);
  if (invoiceLinePriceIds.length === 0) return null;

  let knownIds: readonly string[];
  try {
    knownIds = getKnownStripePriceIdsForKiloClaw();
  } catch {
    // KiloClaw env vars not configured — this invoice can't be KiloClaw.
    return null;
  }
  const knownIdSet = new Set(knownIds);

  for (const line of invoice.lines?.data ?? []) {
    const priceId = line.pricing?.price_details?.price ?? null;
    if (!priceId || !knownIdSet.has(priceId)) continue;

    const metadata = getStripePriceIdMetadata(priceId);
    if (!metadata) return null;

    return {
      priceId,
      plan: metadata.plan,
      priceVersion: metadata.priceVersion,
      isIntro: metadata.isIntro,
      periodStartUnix: line.period?.start ?? null,
      periodEndUnix: line.period?.end ?? null,
    };
  }

  return null;
}

export function invoiceLooksLikeKiloClawByPriceId(invoice: Stripe.Invoice): boolean {
  return classifyKiloClawInvoiceLine(invoice) !== null;
}
