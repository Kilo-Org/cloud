import {
  AutoRoutingAnalyticsPeriodSchema,
  type AutoRoutingAnalyticsPeriod,
  type AutoRoutingClassifierAnalyticsResponse,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import * as z from 'zod';
import type { HonoEnv } from './hono-env';

const PERIODS = {
  '1h': { interval: "INTERVAL '1' HOUR" },
  '24h': { interval: "INTERVAL '24' HOUR" },
  '7d': { interval: "INTERVAL '7' DAY" },
  '30d': { interval: "INTERVAL '30' DAY" },
} as const;

type AnalyticsPeriod = AutoRoutingAnalyticsPeriod;

const analyticsNumberSchema = z.union([z.number(), z.string(), z.null()]);
const optionalAnalyticsNumberSchema = analyticsNumberSchema.optional();

const SummaryRowSchema = z.looseObject({
  total_requests: optionalAnalyticsNumberSchema,
  classified_requests: optionalAnalyticsNumberSchema,
  classifier_errors: optionalAnalyticsNumberSchema,
  invalid_requests: optionalAnalyticsNumberSchema,
  total_cost_credits: optionalAnalyticsNumberSchema,
  avg_duration_ms: optionalAnalyticsNumberSchema,
  p95_duration_ms: optionalAnalyticsNumberSchema,
  avg_confidence: optionalAnalyticsNumberSchema,
  with_session_id: optionalAnalyticsNumberSchema,
  unique_sessions: optionalAnalyticsNumberSchema,
  requires_tools: optionalAnalyticsNumberSchema,
  mirrored_has_tools: optionalAnalyticsNumberSchema,
  avg_body_bytes: optionalAnalyticsNumberSchema,
});
type SummaryRow = z.infer<typeof SummaryRowSchema>;

const StatusBreakdownRowSchema = z.looseObject({
  status: z.string(),
  requests: analyticsNumberSchema,
});
type StatusBreakdownRow = z.infer<typeof StatusBreakdownRowSchema>;

const TaskTypeBreakdownRowSchema = z.looseObject({
  task_type: z.string(),
  requests: analyticsNumberSchema,
  avg_confidence: optionalAnalyticsNumberSchema,
});
type TaskTypeBreakdownRow = z.infer<typeof TaskTypeBreakdownRowSchema>;

const ClassifierModelBreakdownRowSchema = z.looseObject({
  classifier_model: z.string(),
  requests: analyticsNumberSchema,
});
type ClassifierModelBreakdownRow = z.infer<typeof ClassifierModelBreakdownRowSchema>;

function emptyAnalyticsResponse(period: AnalyticsPeriod): AutoRoutingClassifierAnalyticsResponse {
  return {
    period,
    summary: {
      totalRequests: 0,
      classifiedRequests: 0,
      classifierErrors: 0,
      invalidRequests: 0,
      totalCostCredits: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
      avgConfidence: 0,
      withSessionId: 0,
      uniqueSessions: 0,
      requiresTools: 0,
      mirroredHasTools: 0,
      avgBodyBytes: 0,
    },
    statusBreakdown: [],
    taskTypeBreakdown: [],
    classifierModelBreakdown: [],
  };
}

function numberValue(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildSinceClause(period: AnalyticsPeriod): string {
  return `timestamp > NOW() - ${PERIODS[period].interval}`;
}

async function queryAnalyticsEngine<RowSchema extends z.ZodType>(
  env: Env,
  apiToken: string,
  sql: string,
  rowSchema: RowSchema
): Promise<Array<z.infer<RowSchema>>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.O11Y_CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: sql,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analytics Engine query failed (${response.status}): ${errorText}`);
  }

  const result = z.object({ data: z.array(rowSchema) }).parse(await response.json());
  return result.data;
}

function buildSummaryQuery(period: AnalyticsPeriod): string {
  return `
    SELECT
      SUM(_sample_interval) AS total_requests,
      SUM(_sample_interval * IF(blob4 = 'classified', 1, 0)) AS classified_requests,
      SUM(_sample_interval * IF(blob4 = 'classifier_error', 1, 0)) AS classifier_errors,
      SUM(_sample_interval * IF(blob4 IN ('invalid_json', 'invalid_envelope', 'invalid_body'), 1, 0)) AS invalid_requests,
      SUM(_sample_interval * double2) AS total_cost_credits,
      avgIf(double1, double1 > 0) AS avg_duration_ms,
      quantileExactWeighted(0.95)(double1, _sample_interval * IF(double1 > 0, 1, 0)) AS p95_duration_ms,
      avgIf(double3, double3 >= 0) AS avg_confidence,
      SUM(_sample_interval * IF(blob12 != '', 1, 0)) AS with_session_id,
      COUNT(DISTINCT blob12) - IF(SUM(IF(blob12 = '', 1, 0)) > 0, 1, 0) AS unique_sessions,
      SUM(_sample_interval * IF(blob10 = '1', 1, 0)) AS requires_tools,
      SUM(_sample_interval * IF(double5 = 1, 1, 0)) AS mirrored_has_tools,
      avgIf(double6, double6 > 0) AS avg_body_bytes
    FROM auto_routing_classifier_metrics
    WHERE ${buildSinceClause(period)}
    FORMAT JSON
  `;
}

function buildStatusBreakdownQuery(period: AnalyticsPeriod): string {
  return `
    SELECT
      blob4 AS status,
      SUM(_sample_interval) AS requests
    FROM auto_routing_classifier_metrics
    WHERE ${buildSinceClause(period)}
    GROUP BY status
    ORDER BY requests DESC
    LIMIT 20
    FORMAT JSON
  `;
}

function buildTaskTypeBreakdownQuery(period: AnalyticsPeriod): string {
  return `
    SELECT
      blob5 AS task_type,
      SUM(_sample_interval) AS requests,
      avgIf(double3, double3 >= 0) AS avg_confidence
    FROM auto_routing_classifier_metrics
    WHERE ${buildSinceClause(period)} AND blob5 != ''
    GROUP BY task_type
    ORDER BY requests DESC
    LIMIT 20
    FORMAT JSON
  `;
}

function buildClassifierModelBreakdownQuery(period: AnalyticsPeriod): string {
  return `
    SELECT
      blob1 AS classifier_model,
      SUM(_sample_interval) AS requests
    FROM auto_routing_classifier_metrics
    WHERE ${buildSinceClause(period)}
    GROUP BY classifier_model
    ORDER BY requests DESC
    LIMIT 20
    FORMAT JSON
  `;
}

function isLocalRequest(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function isMissingLocalAnalyticsSecret(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('Secret "O11Y_CF_AE_API_TOKEN" not found')
  );
}

export const classifierAnalyticsHandler: Handler<HonoEnv> = async c => {
  const periodParam = c.req.query('period') ?? '24h';
  const parsedPeriod = AutoRoutingAnalyticsPeriodSchema.safeParse(periodParam);
  if (!parsedPeriod.success) {
    return c.json({ error: 'Invalid analytics period' }, 400);
  }

  const period = parsedPeriod.data;
  let summaryRows: SummaryRow[];
  let statusRows: StatusBreakdownRow[];
  let taskRows: TaskTypeBreakdownRow[];
  let modelRows: ClassifierModelBreakdownRow[];

  try {
    const apiToken = await c.env.O11Y_CF_AE_API_TOKEN.get();
    [summaryRows, statusRows, taskRows, modelRows] = await Promise.all([
      queryAnalyticsEngine(c.env, apiToken, buildSummaryQuery(period), SummaryRowSchema),
      queryAnalyticsEngine(
        c.env,
        apiToken,
        buildStatusBreakdownQuery(period),
        StatusBreakdownRowSchema
      ),
      queryAnalyticsEngine(
        c.env,
        apiToken,
        buildTaskTypeBreakdownQuery(period),
        TaskTypeBreakdownRowSchema
      ),
      queryAnalyticsEngine(
        c.env,
        apiToken,
        buildClassifierModelBreakdownQuery(period),
        ClassifierModelBreakdownRowSchema
      ),
    ]);
  } catch (error) {
    if (isLocalRequest(c.req.url) && isMissingLocalAnalyticsSecret(error)) {
      return c.json(emptyAnalyticsResponse(period));
    }
    throw error;
  }

  const summary = summaryRows[0] ?? {};

  const response: AutoRoutingClassifierAnalyticsResponse = {
    period,
    summary: {
      totalRequests: numberValue(summary.total_requests),
      classifiedRequests: numberValue(summary.classified_requests),
      classifierErrors: numberValue(summary.classifier_errors),
      invalidRequests: numberValue(summary.invalid_requests),
      totalCostCredits: numberValue(summary.total_cost_credits),
      avgDurationMs: numberValue(summary.avg_duration_ms),
      p95DurationMs: numberValue(summary.p95_duration_ms),
      avgConfidence: numberValue(summary.avg_confidence),
      withSessionId: numberValue(summary.with_session_id),
      uniqueSessions: numberValue(summary.unique_sessions),
      requiresTools: numberValue(summary.requires_tools),
      mirroredHasTools: numberValue(summary.mirrored_has_tools),
      avgBodyBytes: numberValue(summary.avg_body_bytes),
    },
    statusBreakdown: statusRows.map(row => ({
      status: row.status,
      requests: numberValue(row.requests),
    })),
    taskTypeBreakdown: taskRows.map(row => ({
      taskType: row.task_type,
      requests: numberValue(row.requests),
      avgConfidence: numberValue(row.avg_confidence),
    })),
    classifierModelBreakdown: modelRows.map(row => ({
      classifierModel: row.classifier_model,
      requests: numberValue(row.requests),
    })),
  };
  return c.json(response);
};
