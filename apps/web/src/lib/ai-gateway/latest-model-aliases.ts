import {
  CLAUDE_FABLE_CURRENT_MODEL_ID,
  CLAUDE_HAIKU_CURRENT_MODEL_ID,
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  GEMINI_FLASH_CURRENT_MODEL_ID,
  GEMINI_PRO_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/google';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { GPT_CURRENT_MODEL_ID, GPT_MINI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { GROK_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/xai';

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
] as const;

const latestModelAliasSet = new Set<string>(LATEST_MODEL_ALIASES);

const latestModelAliasTargets = new Map<string, string>([
  [CLAUDE_FABLE_LATEST_MODEL_ALIAS, CLAUDE_FABLE_CURRENT_MODEL_ID],
  [CLAUDE_OPUS_LATEST_MODEL_ALIAS, CLAUDE_OPUS_CURRENT_MODEL_ID],
  [CLAUDE_SONNET_LATEST_MODEL_ALIAS, CLAUDE_SONNET_CURRENT_MODEL_ID],
  [CLAUDE_HAIKU_LATEST_MODEL_ALIAS, CLAUDE_HAIKU_CURRENT_MODEL_ID],
  [GPT_LATEST_MODEL_ALIAS, GPT_CURRENT_MODEL_ID],
  [GPT_MINI_LATEST_MODEL_ALIAS, GPT_MINI_CURRENT_MODEL_ID],
  [KIMI_LATEST_MODEL_ALIAS, KIMI_CURRENT_MODEL_ID],
  [GEMINI_PRO_LATEST_MODEL_ALIAS, GEMINI_PRO_CURRENT_MODEL_ID],
  [GEMINI_FLASH_LATEST_MODEL_ALIAS, GEMINI_FLASH_CURRENT_MODEL_ID],
  [GROK_LATEST_MODEL_ALIAS, GROK_CURRENT_MODEL_ID],
]);

export function isLatestModelAlias(modelId: string): boolean {
  return latestModelAliasSet.has(modelId.trim().toLowerCase());
}

export function resolveLatestModelAlias(modelId: string): string | undefined {
  return latestModelAliasTargets.get(modelId.trim().toLowerCase());
}
