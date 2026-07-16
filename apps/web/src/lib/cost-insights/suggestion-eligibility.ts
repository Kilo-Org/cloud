import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';

import { hasCodingPlanForModel } from '@/lib/coding-plans/pricing';
import type { OwnerTopSpendDriver } from './spend-repository';

export function isCodingPlanSuggestionEligible(
  owner: CostInsightSpendOwner,
  driver: OwnerTopSpendDriver | undefined,
  minimumSpendMicrodollars: number
): boolean {
  return (
    owner.type === 'user' &&
    driver?.category === 'variable' &&
    hasCodingPlanForModel(driver.providerKey, driver.modelOrPlanKey) &&
    driver.totalMicrodollars >= minimumSpendMicrodollars
  );
}
