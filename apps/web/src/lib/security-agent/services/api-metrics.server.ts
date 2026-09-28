import { after } from 'next/server';
import { O11Y_KILO_GATEWAY_CLIENT_SECRET, O11Y_SERVICE_URL } from '@/lib/config.server';

type ApiMetricsTokens = {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheHitTokens?: number;
  totalTokens?: number;
};

type ApiMetricsParams = {
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

const apiMetricsUrl = (() => {
  if (!O11Y_SERVICE_URL) return null;
  try {
    return new URL('/ingest/api-metrics', O11Y_SERVICE_URL);
  } catch {
    return null;
  }
})();

async function sendApiMetrics(params: ApiMetricsParams): Promise<void> {
  if (!apiMetricsUrl || !O11Y_KILO_GATEWAY_CLIENT_SECRET) return;

  await fetch(apiMetricsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-O11Y-ADMIN-TOKEN': O11Y_KILO_GATEWAY_CLIENT_SECRET,
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
