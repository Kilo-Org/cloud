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

const GastownHealthResponseSchema = z.object({
  data: z
    .array(
      z.object({
        weighted_failed_checks: z.number().nonnegative().nullable(),
        weighted_successful_checks: z.number().nonnegative().nullable(),
        affected_town_count: z.number().int().nonnegative().nullable(),
        latest_event_timestamp: z.string().nullable(),
      })
    )
    .max(1),
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

  const sql = `
    SELECT
      SUM(IF(blob5 != '', _sample_interval, 0)) AS weighted_failed_checks,
      SUM(IF(blob5 = '', _sample_interval, 0)) AS weighted_successful_checks,
      uniqExactIf(blob6, blob5 != '' AND blob6 != '') AS affected_town_count,
      MAX(timestamp) AS latest_event_timestamp
    FROM gastown_events
    WHERE timestamp > NOW() - INTERVAL '${GASTOWN_HEALTH_WINDOW_MINUTES}' MINUTE
      AND blob1 = 'container.health_ping'
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

  const parsed = GastownHealthResponseSchema.parse(await response.json());
  const row = parsed.data[0];
  if (!row) {
    return {
      weightedFailedChecks: 0,
      weightedSuccessfulChecks: 0,
      affectedTownCount: 0,
      latestEventTimestamp: null,
    };
  }

  const latestEventTimestamp =
    row.latest_event_timestamp === null
      ? null
      : new Date(toUtcIsoString(row.latest_event_timestamp));
  if (latestEventTimestamp !== null && Number.isNaN(latestEventTimestamp.getTime())) {
    throw new Error('Gastown health Analytics Engine response contains an invalid timestamp');
  }

  return {
    weightedFailedChecks: row.weighted_failed_checks ?? 0,
    weightedSuccessfulChecks: row.weighted_successful_checks ?? 0,
    affectedTownCount: row.affected_town_count ?? 0,
    latestEventTimestamp,
  };
}
