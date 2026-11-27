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
import type { ApiMetricsTokenRead } from './api-metrics-sts';

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
  return resolveApiMetricsSender({
    auth: O11Y_API_METRICS_SENDER_AUTH,
    url: baseUrl ? new URL('/ingest/api-metrics', baseUrl) : null,
    secret: O11Y_KILO_GATEWAY_CLIENT_SECRET,
    runtime: process.env,
  });
})();

const sends = apiMetricsSender.kind === 'legacy' || apiMetricsSender.kind === 'sts';

let senderStateReported = false;

/**
 * Says once per process, on its first metric rather than at load, why it sends nothing: an error
 * for an invalid configuration, a note for `sts` on a deployment o11y does not serve.
 */
function reportSenderStateOnce(): void {
  if (senderStateReported) return;
  senderStateReported = true;
  const sender = apiMetricsSender;
  if (sender.kind === 'misconfigured') {
    console.error('o11y api metrics: invalid sender configuration; sending nothing', {
      reason: sender.reason,
    });
  } else if (sender.kind === 'off' && sender.reason === 'sts_production_only') {
    console.info('o11y api metrics: sts is production only; sending nothing on this deployment');
  }
}

/**
 * This process's STS token health. Metrics dropped for want of a token are counted; the process
 * logs once when it enters `failing` and once when a token is held again, never per metric.
 */
type TokenHealth =
  | { state: 'healthy'; dropped: number }
  | { state: 'failing'; since: number; dropped: number };

let tokenHealth: TokenHealth = { state: 'healthy', dropped: 0 };

function tokenOf(read: ApiMetricsTokenRead): string | null {
  switch (read.kind) {
    case 'token':
      if (tokenHealth.state === 'failing') {
        console.info('o11y api metrics: STS token held again; sending metrics', {
          dropped: tokenHealth.dropped,
          failingMs: Date.now() - tokenHealth.since,
        });
      }
      tokenHealth = { state: 'healthy', dropped: 0 };
      return read.token;
    case 'not_held':
      tokenHealth = { ...tokenHealth, dropped: tokenHealth.dropped + 1 };
      return null;
    case 'failed':
      if (tokenHealth.state === 'healthy') {
        console.error('o11y api metrics: no STS token; dropping metrics until one is held', {
          ...read.failure,
          droppedBefore: tokenHealth.dropped,
        });
        tokenHealth = { state: 'failing', since: Date.now(), dropped: 1 };
      } else {
        tokenHealth = { ...tokenHealth, dropped: tokenHealth.dropped + 1 };
      }
      return null;
  }
}

/**
 * The `Authorization` header of one STS send, or null when the process holds no token. It never
 * waits for a mint: the metric is dropped and the token client renews in the background. It never
 * falls back to the shared secret.
 */
async function stsAuthorization(
  environment: StsEnvironment
): Promise<{ authorization: string } | null> {
  let read: ApiMetricsTokenRead;
  try {
    // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the
    // Vercel OIDC exchange or the STS contracts on this hot path.
    const { apiMetricsToken } = await import('./api-metrics-sts');
    read = await apiMetricsToken(environment);
  } catch (error) {
    read = {
      kind: 'failed',
      failure: { errorName: error instanceof Error ? error.name : typeof error },
    };
  }
  const token = tokenOf(read);
  return token === null ? null : { authorization: `Bearer ${token}` };
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
    // The credential is for this origin only; a redirect never carries it elsewhere.
    redirect: 'error',
  }).catch(() => {
    // Best-effort only; never fail the caller request.
  });
}

export function emitApiMetrics(params: ApiMetricsParams) {
  if (!sends) {
    reportSenderStateOnce();
    return;
  }

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
  if (!sends) {
    reportSenderStateOnce();
    return;
  }

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
