import type { ApiMetricsParams } from '@kilocode/llm-shared';
import { logger } from '../logger.js';

// Background task: emit API metrics to the o11y service
export async function emitApiMetrics(
  params: ApiMetricsParams,
  o11yServiceUrl: string | undefined,
  clientSecret: string | undefined
): Promise<void> {
  if (!o11yServiceUrl || !clientSecret) return;

  try {
    const metricsUrl = new URL('/ingest/api-metrics', o11yServiceUrl);
    await fetch(metricsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-O11Y-ADMIN-TOKEN': clientSecret,
      },
      body: JSON.stringify(params),
    });
  } catch {
    logger.warn('Failed to emit API metrics (best-effort)');
  }
}
