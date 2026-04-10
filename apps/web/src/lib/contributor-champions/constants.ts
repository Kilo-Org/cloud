import type { ContributorChampionTier } from '@kilocode/db/schema-types';

/** Monthly credit amount in USD for each contributor tier. */
export const TIER_CREDIT_USD: Record<ContributorChampionTier, number> = {
  contributor: 0,
  ambassador: 50,
  champion: 150,
};
