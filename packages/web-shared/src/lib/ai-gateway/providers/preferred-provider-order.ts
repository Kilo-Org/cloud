import type {
  PreferredProviderOrderConfig,
  PreferredProviderOrderRule,
} from '@kilocode/db/schema-types';

/** The built-in provider order, used while no configuration is stored. */
export const PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG: PreferredProviderOrderConfig = {
  rules: [
    { includes: ['openai', 'gpt'], excludes: ['gpt-oss'], providers: ['openai'] },
    { includes: ['claude'], providers: ['google-vertex', 'amazon-bedrock'] },
    // do not prefer minimax/highspeed
    { includes: ['minimax'], providers: ['minimax/fp8'] },
    { includes: ['mistral'], providers: ['mistral'] },
    { includes: ['kimi'], providers: ['amazon-bedrock', 'alibaba'] },
    { includes: ['step-'], providers: ['stepfun'] },
    { includes: ['deepseek'], providers: ['novita'] },
    { includes: ['glm'], providers: ['friendli', 'novita'] },
    { includes: ['qwen'], providers: ['alibaba'] },
  ],
};

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
