/**
 * Legacy OpenRouter model IDs that remain valid but are absent from the
 * OpenRouter and models.dev catalogs, with the Vercel AI Gateway model ID that
 * serves each one.
 */
export const LEGACY_OPENROUTER_MODEL_ID_OVERRIDES: Readonly<Record<string, string>> = {
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4.5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'inclusionai/ling-3.0-flash-fin': 'inclusionai/ling-3.0-flash-fin',
  'minimax-m3': 'minimax/minimax-m3',
  'minimax/minimax-m2.5-20260211': 'minimax/minimax-m2.5',
  'poolside/laguna-s-2.1': 'poolside/laguna-s-2.1',
  'qwen/qwen3.8-max': 'alibaba/qwen3.8-max',
  'zai/glm-5.3': 'zai/glm-5.3',
  'zai/glm-5.3-flash': 'zai/glm-5.3-flash',
};

export const legacyOpenRouterAliases: ReadonlySet<string> = new Set(
  Object.keys(LEGACY_OPENROUTER_MODEL_ID_OVERRIDES)
);
