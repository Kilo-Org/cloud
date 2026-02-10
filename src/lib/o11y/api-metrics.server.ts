import { after } from 'next/server';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';
import { O11Y_KILO_GATEWAY_CLIENT_SECRET, O11Y_SERVICE_URL } from '@/lib/config.server';
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
                      resolvedProvider: z.string().min(1).optional(),
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
                      resolvedProvider: z.string().min(1).optional(),
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
  const resolvedProvider =
    choice?.message?.provider_metadata?.gateway?.routing?.resolvedProvider?.trim() ??
    choice?.delta?.provider_metadata?.gateway?.routing?.resolvedProvider?.trim();
  return resolvedProvider || undefined;
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
