import 'server-only';

import type { KiloClawPriceVersion } from '@kilocode/db';

type StripeFundedKiloClawReportingInput = {
  plan: 'commit' | 'standard';
  priceVersion: KiloClawPriceVersion;
  priceId: string;
};

type StripeFundedKiloClawReportingFields = {
  itemCategory: string;
  itemName: string;
  itemSku: string;
};

export function getStripeFundedKiloClawReportingFields(
  input: StripeFundedKiloClawReportingInput
): StripeFundedKiloClawReportingFields {
  return {
    itemCategory: `kiloclaw-${input.plan}-${input.priceVersion}`,
    itemName: input.plan === 'commit' ? 'KiloClaw Commit Plan' : 'KiloClaw Standard Plan',
    itemSku: input.priceId,
  };
}
