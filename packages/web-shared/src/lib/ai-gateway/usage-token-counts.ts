import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type {
  JustTheCostsUsageStats,
  OpenRouterUsage,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export type UsageTokenCounts = Pick<
  JustTheCostsUsageStats,
  'inputTokens' | 'outputTokens' | 'cacheHitTokens' | 'cacheWriteTokens'
>;

export function chatCompletionsUsageTokenCounts(
  usage: OpenRouterUsage | null | undefined
): UsageTokenCounts {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cacheHitTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens:
      usage?.prompt_tokens_details?.cache_write_tokens ??
      usage?.prompt_tokens_details?.cache_creation_input_tokens ??
      0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

export function responsesUsageTokenCounts(
  usage: OpenAI.Responses.ResponseUsage | null | undefined
): UsageTokenCounts {
  // OpenAI-style input_tokens already includes cached and cache-write tokens.
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheHitTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage?.input_tokens_details?.cache_write_tokens ?? 0,
  };
}

export function messagesUsageTokenCounts(
  usage: Anthropic.Messages.MessageDeltaUsage | null | undefined
): UsageTokenCounts {
  // Anthropic-style input_tokens excludes cached and cache-write tokens.
  const cacheHitTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage?.input_tokens ?? 0) + cacheHitTokens + cacheWriteTokens,
    outputTokens: usage?.output_tokens ?? 0,
    cacheHitTokens,
    cacheWriteTokens,
  };
}
