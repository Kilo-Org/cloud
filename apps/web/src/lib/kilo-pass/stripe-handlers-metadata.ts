import 'server-only';

import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { getKiloPassPriceMetadataForId } from '@/lib/kilo-pass/stripe-price-ids.server';
import type Stripe from 'stripe';

export type KiloPassSubscriptionMetadata = {
  type: 'kilo-pass';
  kiloUserId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  kiloPassScheduledChangeId?: string;
};

export type KiloPassPriceMetadata = {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
};

export type KiloPassPriceMetadataWithPriceId = KiloPassPriceMetadata & {
  priceId: string;
};

function parseKiloPassTier(value: string | null | undefined): KiloPassTier | null {
  if (!value) return null;
  if (value === 'tier_19') return KiloPassTier.Tier19;
  if (value === 'tier_49') return KiloPassTier.Tier49;
  if (value === 'tier_199') return KiloPassTier.Tier199;
  return null;
}

function parseKiloPassCadence(value: string | null | undefined): KiloPassCadence | null {
  if (value === KiloPassCadence.Monthly) return KiloPassCadence.Monthly;
  if (value === KiloPassCadence.Yearly) return KiloPassCadence.Yearly;
  return null;
}

type InvoiceLinePriceCandidate = {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  priceId: string;
  amount: number;
};

export function getKiloPassPriceMetadataFromInvoice(
  invoice: Stripe.Invoice
): KiloPassPriceMetadataWithPriceId | null {
  const lines = invoice.lines?.data ?? [];
  const candidates: InvoiceLinePriceCandidate[] = [];

  for (const line of lines) {
    const priceId = line.pricing?.price_details?.price ?? null;
    const meta = getKiloPassPriceMetadataForId(priceId);
    if (!meta || !priceId) continue;

    candidates.push({
      tier: meta.tier,
      cadence: meta.cadence,
      priceId,
      amount: typeof line.amount === 'number' ? line.amount : 0,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const absDiff = Math.abs(b.amount) - Math.abs(a.amount);
    if (absDiff !== 0) return absDiff;
    return b.amount - a.amount;
  });

  const best = candidates[0] ?? null;
  if (!best) return null;
  return { tier: best.tier, cadence: best.cadence, priceId: best.priceId };
}

export function getKiloPassMetadataFromStripeMetadata(
  metadata: Stripe.Metadata | null | undefined
): KiloPassSubscriptionMetadata | null {
  if (metadata?.type !== 'kilo-pass') return null;

  const kiloUserId = metadata.kiloUserId;
  const tier = parseKiloPassTier(metadata.tier);
  const cadence = parseKiloPassCadence(metadata.cadence);

  if (!kiloUserId || !tier || !cadence) return null;
  return {
    kiloUserId,
    tier,
    cadence,
    type: 'kilo-pass',
    kiloPassScheduledChangeId: metadata.kiloPassScheduledChangeId,
  };
}

export function getKiloPassSubscriptionMetadata(
  subscription: Stripe.Subscription
): KiloPassSubscriptionMetadata | null {
  return getKiloPassMetadataFromStripeMetadata(subscription.metadata);
}
