import { z } from 'zod';

export const GASTOWN_HEALTH_WINDOW_MINUTES = 5;

export type GastownHealthMetrics = {
  weightedFailedChecks: number;
  weightedSuccessfulChecks: number;
  affectedTownCount: number;
  latestEventTimestamp: Date | null;
};

type QueryEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_AE_API_TOKEN: SecretsStoreSecret;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const AnalyticsEngineNumberSchema = z.preprocess(
  value => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  z.number().finite().nonnegative().nullable()
);

const GastownHealthResponseSchema = z.object({
  data: z.array(
    z.object({
      town_id: z.string(),
      weighted_failed_checks: AnalyticsEngineNumberSchema,
      weighted_successful_checks: AnalyticsEngineNumberSchema,
      latest_event_timestamp: z.string().nullable(),
    })
  ),
});

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// Analytics Engine MAX(timestamp) may return strings like "2026-06-24 15:10:00.000"
// without a timezone offset. Append "Z" when no offset or "Z" suffix is present so
// new Date() treats the value as UTC rather than the runtime's local timezone.
function toUtcIsoString(value: string): string {
  return /[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
}

export async function queryGastownHealth(
  env: QueryEnv,
  fetchFn: FetchFn = fetch
): Promise<GastownHealthMetrics> {
  const apiToken = await env.O11Y_CF_AE_API_TOKEN.get();
  if (!apiToken) {
    throw new Error('O11Y_CF_AE_API_TOKEN secret is not configured');
  }

  // Collapse healthy towns into one row so normal fleet size does not inflate the
  // scheduled Worker's Analytics Engine response and Cloudflare trace payload.
  const sql = `
    SELECT
      IF(blob5 != '' AND blob6 != '', blob6, '') AS town_id,
      SUM(IF(blob5 != '', _sample_interval, 0)) AS weighted_failed_checks,
      SUM(IF(blob5 = '', _sample_interval, 0)) AS weighted_successful_checks,
      MAX(timestamp) AS latest_event_timestamp
    FROM gastown_events
    WHERE timestamp > NOW() - INTERVAL '${GASTOWN_HEALTH_WINDOW_MINUTES}' MINUTE
      AND blob1 = 'container.health_ping'
    GROUP BY town_id
    FORMAT JSON
  `;

  const response = await fetchFn(
    `${CF_API_BASE}/accounts/${env.O11Y_CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: sql,
      signal: AbortSignal.timeout(5_000),
    }
  );

  if (!response.ok) {
    throw new Error(`Gastown health Analytics Engine query failed (${response.status})`);
  }

  const { data } = GastownHealthResponseSchema.parse(await response.json());
  let weightedFailedChecks = 0;
  let weightedSuccessfulChecks = 0;
  let affectedTownCount = 0;
  let latestEventTimestamp: Date | null = null;

  for (const row of data) {
    const failedChecks = row.weighted_failed_checks ?? 0;
    weightedFailedChecks += failedChecks;
    weightedSuccessfulChecks += row.weighted_successful_checks ?? 0;
    if (row.town_id !== '' && failedChecks > 0) affectedTownCount += 1;

    if (row.latest_event_timestamp !== null) {
      const rowTimestamp = new Date(toUtcIsoString(row.latest_event_timestamp));
      if (Number.isNaN(rowTimestamp.getTime())) {
        throw new Error('Gastown health Analytics Engine response contains an invalid timestamp');
      }
      if (latestEventTimestamp === null || rowTimestamp > latestEventTimestamp) {
        latestEventTimestamp = rowTimestamp;
      }
    }
  }

  return {
    weightedFailedChecks,
    weightedSuccessfulChecks,
    affectedTownCount,
    latestEventTimestamp,
  };
}
