import { after } from 'next/server';
import {
  O11Y_API_METRICS_SENDER_AUTH,
  O11Y_KILO_GATEWAY_CLIENT_SECRET,
  O11Y_SERVICE_URL,
} from '@kilocode/web-shared/lib/config.server';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { MicrodollarUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { parseInternalServiceUrl } from '@kilocode/web-shared/lib/internal-service-url';
import { resolveApiMetricsSender } from './api-metrics-sender';
import type { StsEnvironment } from '@kilocode/sts-contracts';

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
      isObjectEntry(tool) ? [labeledTool('function', 'name' in tool ? tool.name : undefined)] : []
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

const apiMetricsSender = (() => {
  const baseUrl = parseInternalServiceUrl(O11Y_SERVICE_URL);
  const sender = resolveApiMetricsSender({
    auth: O11Y_API_METRICS_SENDER_AUTH,
    url: baseUrl ? new URL('/ingest/api-metrics', baseUrl) : null,
    secret: O11Y_KILO_GATEWAY_CLIENT_SECRET,
    runtime: process.env,
  });
  if (sender.kind === 'misconfigured') {
    console.error('o11y api metrics: invalid sender configuration; sending nothing', {
      reason: sender.reason,
    });
  }
  return sender;
})();

const sends = apiMetricsSender.kind === 'legacy' || apiMetricsSender.kind === 'sts';

/**
 * The `Authorization` header of one STS send, or null when there is no token. The token client
 * retries within its own attempt timeout and backoff; after that the metric is not sent and the
 * failure is logged, never retried with the shared secret.
 */
async function stsAuthorization(
  environment: StsEnvironment
): Promise<{ authorization: string } | null> {
  try {
    // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the
    // Vercel OIDC exchange or the STS contracts on this hot path.
    const { apiMetricsToken } = await import('./api-metrics-sts');
    return { authorization: `Bearer ${await apiMetricsToken(environment)}` };
  } catch (error) {
    // Neither `ServiceTokenError` nor the Vercel identity's error carries a token.
    console.error('o11y api metrics: no STS token; metric not sent', {
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : undefined,
    });
    return null;
  }
}

async function sendApiMetrics(params: ApiMetricsParams): Promise<void> {
  const sender = apiMetricsSender;
  if (sender.kind !== 'legacy' && sender.kind !== 'sts') return;
  const credential =
    sender.kind === 'legacy'
      ? { 'X-O11Y-ADMIN-TOKEN': sender.secret }
      : await stsAuthorization(sender.environment);
  if (credential === null) return;

  await fetch(sender.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...credential,
    },
    body: JSON.stringify(params),
  }).catch(() => {
    // Best-effort only; never fail the caller request.
  });
}

export function emitApiMetrics(params: ApiMetricsParams) {
  if (!sends) return;

  after(async () => {
    await sendApiMetrics(params);
  });
}

export function emitGatewayApiMetrics(params: ApiMetricsParams) {
  emitApiMetrics(params);
}

export function emitApiMetricsForResponse(
  params: Omit<ApiMetricsParams, 'completeRequestMs'>,
  statsPromise: Promise<Pick<MicrodollarUsageStats, 'inference_provider'> | null>,
  requestStartedAt: number
) {
  if (!sends) return;

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
