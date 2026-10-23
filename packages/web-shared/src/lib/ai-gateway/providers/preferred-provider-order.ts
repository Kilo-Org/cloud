import type {
  PreferredProviderOrderConfig,
  PreferredProviderOrderRule,
} from '@kilocode/db/schema-types';

export const EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG: PreferredProviderOrderConfig = { rules: [] };

function matchesRule(rule: PreferredProviderOrderRule, requestedModel: string): boolean {
  return (
    rule.includes.some(substring => requestedModel.includes(substring)) &&
    !rule.excludes?.some(substring => requestedModel.includes(substring))
  );
}

/** Index of the first rule matching the model, or -1 when no rule matches. */
export function findPreferredProviderOrderRuleIndex(
  config: PreferredProviderOrderConfig,
  requestedModel: string
): number {
  return config.rules.findIndex(rule => matchesRule(rule, requestedModel));
}

export function resolvePreferredProviderOrder(
  config: PreferredProviderOrderConfig,
  requestedModel: string
): string[] {
  const rule = config.rules[findPreferredProviderOrderRuleIndex(config, requestedModel)];
  return rule ? [...rule.providers] : [];
}
