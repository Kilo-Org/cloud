import { z } from 'zod';

export const GASTOWN_HEALTH_WINDOW_MINUTES = 15;

/**
 * Per-town container-health signals over the evaluation window. Only towns with
 * evidence of a problem are returned (see the HAVING clause below); a fully
 * healthy fleet produces zero rows here — fleet liveness is confirmed separately
 * via the aggregate heartbeat query.
 */
export type GastownTownSignal = {
  townId: string;
  weightedFailedChecks: number;
  weightedSuccessfulChecks: number;
  weightedExhausted: number;
  weightedRecovered: number;
  weightedWatchdogCodeUpdated: number;
  // MIN/MAX event timestamps for the town over the window. For a sustained-wedge
  // town (zero successes and zero recoveries) the only events are failed pings,
  // so this span is exactly the continuous-failure span used by the predicate.
  firstEventAt: Date | null;
  lastEventAt: Date | null;
};

export type GastownHealthMetrics = {
  townSignals: GastownTownSignal[];
  // Fleet-wide aggregate over container.health_ping (info trend + liveness).
  // Drives the non-paging flapping signal and lets the state machine tell a
  // recovered fleet apart from a telemetry blackout.
  aggregateWeightedFailedChecks: number;
  aggregateWeightedSuccessfulChecks: number;
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

const TownSignalResponseSchema = z.object({
  data: z.array(
    z.object({
      town_id: z.string(),
      weighted_failed_checks: AnalyticsEngineNumberSchema,
      weighted_successful_checks: AnalyticsEngineNumberSchema,
      weighted_exhausted: AnalyticsEngineNumberSchema,
      weighted_recovered: AnalyticsEngineNumberSchema,
      weighted_watchdog_code_updated: AnalyticsEngineNumberSchema,
      first_event_timestamp: z.string().nullable(),
      last_event_timestamp: z.string().nullable(),
    })
  ),
});

const AggregateResponseSchema = z.object({
  data: z.array(
    z.object({
      weighted_failed_checks: AnalyticsEngineNumberSchema,
      weighted_successful_checks: AnalyticsEngineNumberSchema,
      latest_event_timestamp: z.string().nullable(),
    })
  ),
});

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// Deploy-churn fingerprint: a "code was updated" watchdog error means the Town
// DO was reset mid-alarm by a code deploy, not a genuine wedge. A broad spike of
// these across many towns indicates deploy churn rather than an incident.
const DEPLOY_CHURN_FINGERPRINT = 'code was updated';

// Analytics Engine MAX(timestamp) may return strings like "2026-06-24 15:10:00.000"
// without a timezone offset. Append "Z" when no offset or "Z" suffix is present so
// new Date() treats the value as UTC rather than the runtime's local timezone.
function toUtcIsoString(value: string): string {
  return /[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
}

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(toUtcIsoString(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Gastown health Analytics Engine response contains an invalid timestamp');
  }
  return parsed;
}

async function runQuery(
  env: QueryEnv,
  fetchFn: FetchFn,
  apiToken: string,
  sql: string
): Promise<unknown> {
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

  return response.json();
}

// Per-town wedge signals. Groups every container health event by town, then uses
// HAVING to drop fully healthy towns so a large healthy fleet does not inflate the
// scheduled Worker's Analytics Engine response and Cloudflare trace payload.
const TOWN_SIGNAL_SQL = `
  SELECT
    blob6 AS town_id,
    SUM(IF(blob1 = 'container.health_ping' AND blob5 != '', _sample_interval, 0)) AS weighted_failed_checks,
    SUM(IF(blob1 = 'container.health_ping' AND blob5 = '', _sample_interval, 0)) AS weighted_successful_checks,
    SUM(IF(blob1 = 'container.auto_restart_exhausted', _sample_interval, 0)) AS weighted_exhausted,
    SUM(IF(blob1 = 'container.health_recovered', _sample_interval, 0)) AS weighted_recovered,
    SUM(IF(blob1 = 'container.health_watchdog_error' AND position('${DEPLOY_CHURN_FINGERPRINT}' IN blob5) > 0, _sample_interval, 0)) AS weighted_watchdog_code_updated,
    MIN(timestamp) AS first_event_timestamp,
    MAX(timestamp) AS last_event_timestamp
  FROM gastown_events
  WHERE timestamp > NOW() - INTERVAL '${GASTOWN_HEALTH_WINDOW_MINUTES}' MINUTE
    AND blob6 != ''
    AND blob1 IN (
      'container.health_ping',
      'container.auto_restart_exhausted',
      'container.health_recovered',
      'container.health_watchdog_error'
    )
  GROUP BY town_id
  HAVING weighted_failed_checks > 0
      OR weighted_exhausted > 0
      OR weighted_recovered > 0
      OR weighted_watchdog_code_updated > 0
  FORMAT JSON
`;

// Fleet-wide health-ping aggregate: a single row confirming liveness and giving
// the info-trend flapping totals independent of the per-town HAVING filter.
const AGGREGATE_SQL = `
  SELECT
    SUM(IF(blob5 != '', _sample_interval, 0)) AS weighted_failed_checks,
    SUM(IF(blob5 = '', _sample_interval, 0)) AS weighted_successful_checks,
    MAX(timestamp) AS latest_event_timestamp
  FROM gastown_events
  WHERE timestamp > NOW() - INTERVAL '${GASTOWN_HEALTH_WINDOW_MINUTES}' MINUTE
    AND blob1 = 'container.health_ping'
  FORMAT JSON
`;

export async function queryGastownHealth(
  env: QueryEnv,
  fetchFn: FetchFn = fetch
): Promise<GastownHealthMetrics> {
  const apiToken = await env.O11Y_CF_AE_API_TOKEN.get();
  if (!apiToken) {
    throw new Error('O11Y_CF_AE_API_TOKEN secret is not configured');
  }

  const [townSignalRaw, aggregateRaw] = await Promise.all([
    runQuery(env, fetchFn, apiToken, TOWN_SIGNAL_SQL),
    runQuery(env, fetchFn, apiToken, AGGREGATE_SQL),
  ]);

  const townRows = TownSignalResponseSchema.parse(townSignalRaw).data;
  const townSignals: GastownTownSignal[] = townRows.map(row => ({
    townId: row.town_id,
    weightedFailedChecks: row.weighted_failed_checks ?? 0,
    weightedSuccessfulChecks: row.weighted_successful_checks ?? 0,
    weightedExhausted: row.weighted_exhausted ?? 0,
    weightedRecovered: row.weighted_recovered ?? 0,
    weightedWatchdogCodeUpdated: row.weighted_watchdog_code_updated ?? 0,
    firstEventAt: parseTimestamp(row.first_event_timestamp),
    lastEventAt: parseTimestamp(row.last_event_timestamp),
  }));

  const aggregateRow = AggregateResponseSchema.parse(aggregateRaw).data[0];

  return {
    townSignals,
    aggregateWeightedFailedChecks: aggregateRow?.weighted_failed_checks ?? 0,
    aggregateWeightedSuccessfulChecks: aggregateRow?.weighted_successful_checks ?? 0,
    latestEventTimestamp: parseTimestamp(aggregateRow?.latest_event_timestamp ?? null),
  };
}
