export const CLAUDE_FABLE_LATEST_MODEL_ALIAS = '~anthropic/claude-fable-latest';
export const CLAUDE_OPUS_LATEST_MODEL_ALIAS = '~anthropic/claude-opus-latest';
export const CLAUDE_SONNET_LATEST_MODEL_ALIAS = '~anthropic/claude-sonnet-latest';
export const CLAUDE_HAIKU_LATEST_MODEL_ALIAS = '~anthropic/claude-haiku-latest';
export const GPT_LATEST_MODEL_ALIAS = '~openai/gpt-latest';
export const GPT_MINI_LATEST_MODEL_ALIAS = '~openai/gpt-mini-latest';
export const KIMI_LATEST_MODEL_ALIAS = '~moonshotai/kimi-latest';
export const GEMINI_PRO_LATEST_MODEL_ALIAS = '~google/gemini-pro-latest';
export const GEMINI_FLASH_LATEST_MODEL_ALIAS = '~google/gemini-flash-latest';
export const GROK_LATEST_MODEL_ALIAS = '~x-ai/grok-latest';
export const DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS = '~deepseek/deepseek-v4-flash-latest';

export const LATEST_MODEL_ALIASES = [
  CLAUDE_FABLE_LATEST_MODEL_ALIAS,
  CLAUDE_OPUS_LATEST_MODEL_ALIAS,
  CLAUDE_SONNET_LATEST_MODEL_ALIAS,
  CLAUDE_HAIKU_LATEST_MODEL_ALIAS,
  GPT_LATEST_MODEL_ALIAS,
  GPT_MINI_LATEST_MODEL_ALIAS,
  KIMI_LATEST_MODEL_ALIAS,
  GEMINI_PRO_LATEST_MODEL_ALIAS,
  GEMINI_FLASH_LATEST_MODEL_ALIAS,
  GROK_LATEST_MODEL_ALIAS,
  DEEPSEEK_V4_FLASH_LATEST_MODEL_ALIAS,
] as const;

const latestModelAliasSet = new Set<string>(LATEST_MODEL_ALIASES);

export function isLatestModelAlias(modelId: string): boolean {
  return latestModelAliasSet.has(modelId);
}
