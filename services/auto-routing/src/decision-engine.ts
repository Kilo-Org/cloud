import {
  deriveDifficultyTier,
  type AutoRoutingDecision,
  type ClassifierOutput,
  type NormalizedClassifierInput,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';

export function computeDecision(
  classification: ClassifierOutput,
  apiKind: NormalizedClassifierInput['apiKind'],
  table: RoutingTable
): AutoRoutingDecision | null {
  const tier = deriveDifficultyTier(classification);
  const candidate = table.tiers[tier].find(c => c.supportedApiKinds.includes(apiKind));
  if (!candidate) return null;
  return { model: candidate.model, tier, source: table.source, tableVersion: table.version };
}
