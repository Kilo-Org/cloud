import { after } from 'next/server';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';
import { O11Y_KILO_GATEWAY_CLIENT_SECRET, O11Y_SERVICE_URL } from '@/lib/config.server';
import type { CompletionUsage } from 'openai/resources/completions';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

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

export function getToolsAvailable(request: GatewayRequest): string[] {
  if (!Array.isArray(request.body.tools)) return [];

  if (request.kind === 'responses') {
    return request.body.tools.map((tool): string => {
      if (tool.type === 'function') return labeledTool('function', tool.name);
      if (tool.type === 'custom') return labeledTool('custom', tool.name);
      if (tool.type === 'mcp') return labeledTool('mcp', tool.server_label);
      return tool.type;
    });
  }

  if (request.kind === 'messages') {
    return request.body.tools.map((tool): string => labeledTool('function', tool.name));
  }

  return request.body.tools.map((tool): string => {
    if (tool.type === 'function') return labeledTool('function', tool.function?.name);
    if (tool.type === 'custom') return labeledTool('custom', tool.custom?.name);
    return 'unknown:unknown';
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

    for (const toolCall of message.tool_calls ?? []) {
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
  if (!O11Y_KILO_GATEWAY_CLIENT_SECRET) return;

  await fetch(apiMetricsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-O11Y-ADMIN-TOKEN': O11Y_KILO_GATEWAY_CLIENT_SECRET || '',
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

export function emitApiMetricsForResponse(
  params: Omit<ApiMetricsParams, 'clientSecret' | 'completeRequestMs'>,
  responseToDrain: Response,
  requestStartedAt: number
) {
  if (!apiMetricsUrl) return;
  if (!O11Y_KILO_GATEWAY_CLIENT_SECRET) return;

  after(async () => {
    let inferenceProvider: string | undefined;
    try {
      // Draining the body lets us measure the full upstream response time.
      // Cap this so we don't keep background work running forever for SSE.
      inferenceProvider = await drainResponseBodyForInferenceProvider(responseToDrain, 60_000);
    } catch {
      // Ignore body read errors; we still emit a timing.
    }

    const completeRequestMs = Math.max(0, Math.round(performance.now() - requestStartedAt));

    await sendApiMetrics({
      ...params,
      inferenceProvider,
      clientSecret: O11Y_KILO_GATEWAY_CLIENT_SECRET,
      completeRequestMs,
    } satisfies ApiMetricsParams);
  });
}

async function drainResponseBodyForInferenceProvider(
  response: Response,
  timeoutMs: number
): Promise<string | undefined> {
  const body = response.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const contentType = response.headers.get('content-type') ?? '';
  const isEventStream = contentType.includes('text/event-stream');
  try {
    const startedAt = performance.now();
    const decoder = new TextDecoder();
    let inferenceProvider: string | undefined;

    const sseParser = isEventStream
      ? createParser({
          onEvent(event: EventSourceMessage) {
            if (event.data === '[DONE]') return;
            const json = safeParseJson(event.data);
            if (!json) return;
            inferenceProvider = extractInferenceProvider(json);
          },
        })
      : null;

    let buffered = '';
    const MAX_BUFFER_CHARS = 512_000;

    while (true) {
      const elapsedMs = performance.now() - startedAt;
      const remainingMs = timeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        try {
          await reader.cancel();
        } catch {
          /** intentionally empty */
        }
        return inferenceProvider;
      }

      const result = await Promise.race([
        reader.read(),
        sleep(remainingMs).then(() => ({ timeout: true as const })),
      ]);

      if ('timeout' in result) {
        try {
          await reader.cancel();
        } catch {
          /** intentionally empty */
        }
        return inferenceProvider;
      }

      if (result.done) {
        if (!inferenceProvider && !isEventStream && buffered) {
          const json = safeParseJson(buffered);
          inferenceProvider = json ? extractInferenceProvider(json) : undefined;
        }
        return inferenceProvider;
      }

      if (result.value) {
        const chunk = decoder.decode(result.value, { stream: true });
        if (sseParser) {
          sseParser.feed(chunk);
        } else if (buffered.length < MAX_BUFFER_CHARS) {
          buffered += chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const inferenceProviderSchema = z.object({
  provider: z.string().min(1).optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            provider_metadata: z
              .object({
                gateway: z
                  .object({
                    routing: z.object({
                      finalProvider: z.string().min(1).optional(),
                    }),
                  })
                  .partial()
                  .optional(),
              })
              .partial()
              .optional(),
          })
          .partial()
          .optional(),
        delta: z
          .object({
            provider_metadata: z
              .object({
                gateway: z
                  .object({
                    routing: z.object({
                      finalProvider: z.string().min(1).optional(),
                    }),
                  })
                  .partial()
                  .optional(),
              })
              .partial()
              .optional(),
          })
          .partial()
          .optional(),
      })
    )
    .optional(),
});

function extractInferenceProvider(data: unknown): string | undefined {
  const parsed = inferenceProviderSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const directProvider = parsed.data.provider?.trim();
  if (directProvider) return directProvider;

  const choice = parsed.data.choices?.[0];
  const finalProvider =
    choice?.message?.provider_metadata?.gateway?.routing?.finalProvider?.trim() ??
    choice?.delta?.provider_metadata?.gateway?.routing?.finalProvider?.trim();
  return finalProvider || undefined;
}

function safeParseJson(payload: string): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
