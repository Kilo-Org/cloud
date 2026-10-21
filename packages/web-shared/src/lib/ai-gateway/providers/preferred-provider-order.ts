import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';

/** The built-in provider order, used while no configuration is stored. */
export const PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG: PreferredProviderOrderConfig = {
  rules: [
    { substring: 'gpt-oss', providers: [] },
    { substring: 'openai', providers: ['openai'] },
    { substring: 'gpt', providers: ['openai'] },
    { substring: 'claude', providers: ['google-vertex', 'amazon-bedrock'] },
    // do not prefer minimax/highspeed
    { substring: 'minimax', providers: ['minimax/fp8'] },
    { substring: 'mistral', providers: ['mistral'] },
    { substring: 'kimi', providers: ['amazon-bedrock', 'alibaba'] },
    { substring: 'step-', providers: ['stepfun'] },
    { substring: 'deepseek', providers: ['novita'] },
    { substring: 'glm', providers: ['friendli', 'novita'] },
    { substring: 'qwen', providers: ['alibaba'] },
  ],
};

export function resolvePreferredProviderOrder(
  config: PreferredProviderOrderConfig,
  requestedModel: string
): string[] {
  const rule = config.rules.find(({ substring }) => requestedModel.includes(substring));
  return rule ? [...rule.providers] : [];
}
