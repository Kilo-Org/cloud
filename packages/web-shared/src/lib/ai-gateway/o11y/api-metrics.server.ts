import { after } from 'next/server';
import {
  O11Y_KILO_GATEWAY_CLIENT_SECRET,
  O11Y_SERVICE_URL,
} from '@kilocode/web-shared/lib/config.server';
import type { CompletionUsage } from 'openai/resources/completions';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { MicrodollarUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export type ApiMetricsTokens = {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheHitTokens?: number;
  totalTokens?: number;
};

export type ApiMetricsParams = {
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
    // cacheWriteTokens isn't reported in OpenAI/OpenRouter usage.
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

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function labeledTool(kind: string, name: unknown): string {
  const trimmed = trimString(name);
  return trimmed ? `${kind}:${trimmed}` : `${kind}:unknown`;
}

function isObjectEntry<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}

export function getToolsAvailable(request: GatewayRequest): string[] {
  if (!Array.isArray(request.body.tools)) return [];

  if (request.kind === 'responses') {
    return request.body.tools.flatMap((tool): string[] => {
      if (!isObjectEntry(tool)) return [];
      if (tool.type === 'function') return [labeledTool('function', tool.name)];
      if (tool.type === 'custom') return [labeledTool('custom', tool.name)];
      if (tool.type === 'mcp') return [labeledTool('mcp', tool.server_label)];
      return typeof tool.type === 'string' && tool.type ? [tool.type] : ['unknown:unknown'];
    });
  }

  if (request.kind === 'messages') {
    return request.body.tools.flatMap((tool): string[] =>
      isObjectEntry(tool) ? [labeledTool('function', tool.name)] : []
    );
  }

  return request.body.tools.flatMap((tool): string[] => {
    if (!isObjectEntry(tool)) return [];
    if (tool.type === 'function') return [labeledTool('function', tool.function?.name)];
    if (tool.type === 'custom') return [labeledTool('custom', tool.custom?.name)];
    return ['unknown:unknown'];
  });
}

export function getToolsUsed(request: GatewayRequest): string[] {
  if (request.kind === 'responses') {
    const { input } = request.body;
    if (!Array.isArray(input)) return [];

    const used = new Array<string>();

    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'function_call') {
        used.push(labeledTool('function', item.name));
      } else if (item.type === 'custom_tool_call') {
        used.push(labeledTool('custom', item.name));
      }
    }

    return used;
  }

  if (request.kind === 'messages') {
    const used = new Array<string>();
    if (!Array.isArray(request.body.messages)) return used;
    for (const message of request.body.messages) {
      if (!message || typeof message !== 'object') continue;
      if (message.role !== 'assistant') continue;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') {
          used.push(labeledTool('function', block.name));
        }
      }
    }
    return used;
  }

  if (!Array.isArray(request.body.messages)) return [];

  const used = new Array<string>();

  for (const message of request.body.messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;

    if (!Array.isArray(message.tool_calls)) continue;

    for (const toolCall of message.tool_calls) {
      if (!toolCall || typeof toolCall !== 'object') continue;
      if (toolCall.type === 'function') {
        used.push(labeledTool('function', toolCall.function?.name));
        continue;
      }

      if (toolCall.type === 'custom') {
        used.push(labeledTool('custom', toolCall.custom?.name));
        continue;
      }

      used.push('unknown:unknown');
    }
  }

  return used;
}

const apiMetricsUrl = (() => {
  if (!O11Y_SERVICE_URL) return null;
  try {
    return new URL('/ingest/api-metrics', O11Y_SERVICE_URL);
  } catch {
    return null;
  }
})();

async function sendApiMetrics(params: ApiMetricsParams): Promise<void> {
  if (!apiMetricsUrl) return;
  const clientSecret = O11Y_KILO_GATEWAY_CLIENT_SECRET;
  if (!clientSecret) return;

  await fetch(apiMetricsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-O11Y-ADMIN-TOKEN': clientSecret,
    },
    body: JSON.stringify(params),
  }).catch(() => {
    // Best-effort only; never fail the caller request.
  });
}

export function emitApiMetrics(params: ApiMetricsParams) {
  if (!apiMetricsUrl) return;

  after(async () => {
    await sendApiMetrics(params);
  });
}

export function emitGatewayApiMetrics(params: ApiMetricsParams) {
  if (!O11Y_KILO_GATEWAY_CLIENT_SECRET) return;
  emitApiMetrics(params);
}

export function emitApiMetricsForResponse(
  params: Omit<ApiMetricsParams, 'completeRequestMs'>,
  statsPromise: Promise<Pick<MicrodollarUsageStats, 'inference_provider'> | null>,
  requestStartedAt: number
) {
  if (!apiMetricsUrl) return;
  if (!O11Y_KILO_GATEWAY_CLIENT_SECRET) return;

  // Accounting reports a usage parse failure; metrics still record the request without a provider.
  after(
    statsPromise
      .catch(() => null)
      .then(async stats => {
        const completeRequestMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

        await sendApiMetrics({
          ...params,
          inferenceProvider: stats?.inference_provider ?? undefined,
          completeRequestMs,
        } satisfies ApiMetricsParams);
      })
  );
}
