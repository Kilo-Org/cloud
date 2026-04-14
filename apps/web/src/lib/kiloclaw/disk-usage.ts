import { getEnvVariable } from '@/lib/dotenvx';

export type ControllerTelemetryRow = {
  timestamp: string;
  sandbox_id: string;
  machine_id: string;
  disk_used_bytes: number;
  disk_total_bytes: number;
};

export type AnalyticsEngineResponse<T> = {
  data: T[];
  meta: { name: string; type: string }[];
  rows: number;
};

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function buildDiskUsageQuery(sandboxId: string): string {
  return `SELECT
  timestamp,
  blob1 AS sandbox_id,
  blob8 AS machine_id,
  double7 AS disk_used_bytes,
  double8 AS disk_total_bytes
FROM kiloclaw_controller_telemetry
WHERE index1 = '${sandboxId}'
ORDER BY timestamp DESC
LIMIT 1
FORMAT JSON`;
}

export async function queryDiskUsage(
  sandboxId: string
): Promise<AnalyticsEngineResponse<ControllerTelemetryRow>> {
  if (!sandboxId || !isSafeIdentifier(sandboxId)) {
    throw new Error('Invalid or missing sandboxId');
  }

  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const token = getEnvVariable('CF_ANALYTICS_ENGINE_TOKEN');

  if (!accountId || !token) {
    throw new Error('Missing Cloudflare Analytics Engine configuration');
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: buildDiskUsageQuery(sandboxId),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Analytics Engine API error:', response.status, errorText);
    throw new Error(`Analytics Engine API error: ${response.status}`);
  }

  return response.json() as Promise<AnalyticsEngineResponse<ControllerTelemetryRow>>;
}
