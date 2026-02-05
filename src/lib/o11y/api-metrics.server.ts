import { after } from 'next/server';
import { O11Y_SERVICE_URL } from '@/lib/config.server';

export type ApiMetricsParams = {
  clientName: string;
  clientSecret: string;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
};

let url: URL;
try {
  url = new URL('/ingest/api-metrics', O11Y_SERVICE_URL);
} catch {
  /** intentionally empty */
}

export function emitApiMetrics(params: ApiMetricsParams) {
  if (!O11Y_SERVICE_URL) return;

  after(async () => {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    }).catch(() => {
      // Best-effort only; never fail the caller request.
    });
  });
}
