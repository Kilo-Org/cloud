import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';

export type ApiMetricsTokens = {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheHitTokens?: number;
  totalTokens?: number;
};

export type ApiMetricsParams = {
  clientSecret: string;
  kiloUserId: string;
  organizationId?: string;
  isAnonymous: boolean;
  isStreaming: boolean;
  userByok: boolean;
  mode?: string;
  provider: string;
  inferenceProvider?: string;
  requestedModel: string;
  resolvedModel: string;
  toolsAvailable: string[];
  toolsUsed: string[];
  ttfbMs: number;
  completeRequestMs: number;
  statusCode: number;
  tokens?: ApiMetricsTokens;
};

export function getTokensFromCompletionUsage(
  usage: CompletionUsage | null | undefined
): ApiMetricsTokens | undefined {
  if (!usage) return undefined;

  const tokens: ApiMetricsTokens = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheHitTokens: usage.prompt_tokens_details?.cached_tokens,
    totalTokens: usage.total_tokens,
    cacheWriteTokens: undefined,
  };

  const hasAny =
    tokens.inputTokens !== undefined ||
    tokens.outputTokens !== undefined ||
    tokens.cacheWriteTokens !== undefined ||
    tokens.cacheHitTokens !== undefined ||
    tokens.totalTokens !== undefined;

  return hasAny ? tokens : undefined;
}

export function getToolsAvailable(
  tools: Array<OpenAI.Chat.Completions.ChatCompletionTool> | undefined
): string[] {
  if (!tools) return [];

  return tools.map((tool): string => {
    if (tool.type === 'function') {
      const toolName = typeof tool.function?.name === 'string' ? tool.function.name.trim() : '';
      return toolName ? `function:${toolName}` : 'function:unknown';
    }

    if (tool.type === 'custom') {
      const toolName = typeof tool.custom?.name === 'string' ? tool.custom.name.trim() : '';
      return toolName ? `custom:${toolName}` : 'custom:unknown';
    }

    return 'unknown:unknown';
  });
}

export function getToolsUsed(
  messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> | undefined
): string[] {
  if (!messages) return [];

  const used = new Array<string>();

  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.type === 'function') {
        const toolName =
          typeof toolCall.function?.name === 'string' ? toolCall.function.name.trim() : '';
        used.push(toolName ? `function:${toolName}` : 'function:unknown');
        continue;
      }

      if (toolCall.type === 'custom') {
        const toolName =
          typeof toolCall.custom?.name === 'string' ? toolCall.custom.name.trim() : '';
        used.push(toolName ? `custom:${toolName}` : 'custom:unknown');
        continue;
      }

      used.push('unknown:unknown');
    }
  }

  return used;
}
