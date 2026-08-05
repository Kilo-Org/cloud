import 'server-only';

import * as z from 'zod';

import {
  CodingPlanQuotaWindowsSchema,
  CodingPlanUsageError,
  type CodingPlanQuotaWindow,
} from '@/lib/coding-plans/usage-contract';

const MINIMAX_USAGE_URL = 'https://api.minimax.io/v1/token_plan/remains';
const MINIMAX_USAGE_TIMEOUT_MS = 5_000;

const NativePercentSchema = z.number().finite().min(0).max(100);
const NativeIntegerSchema = z.number().int().safe();

const MiniMaxModelRemainsSchema = z.object({
  model_name: z.string().min(1).max(128),
  start_time: NativeIntegerSchema.nonnegative().optional(),
  end_time: NativeIntegerSchema.nonnegative().optional(),
  interval_boost_permille: NativeIntegerSchema.nonnegative().optional(),
  current_interval_remaining_percent: NativePercentSchema.optional(),
  current_interval_status: NativeIntegerSchema.optional(),
  weekly_start_time: NativeIntegerSchema.nonnegative().optional(),
  weekly_end_time: NativeIntegerSchema.nonnegative().optional(),
  weekly_boost_permille: NativeIntegerSchema.nonnegative().optional(),
  current_weekly_remaining_percent: NativePercentSchema.optional(),
  current_weekly_status: NativeIntegerSchema.optional(),
});

// `model_remains` is optional so a non-zero application status without quota
// rows still parses and maps to an `application` failure instead of
// `invalid_response`.
const MiniMaxUsageResponseSchema = z.object({
  base_resp: z.object({
    status_code: NativeIntegerSchema,
  }),
  model_remains: z.array(MiniMaxModelRemainsSchema).max(64).optional(),
});

type MiniMaxModelRemains = z.infer<typeof MiniMaxModelRemainsSchema>;

function isoTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function quotaWindow(input: {
  id: 'short_term' | 'weekly';
  percent: number | undefined;
  status: number | undefined;
  start: number | undefined;
  end: number | undefined;
  boostPermille: number | undefined;
  period: CodingPlanQuotaWindow['period'];
}): CodingPlanQuotaWindow | null {
  if (input.status === 3 || input.percent === undefined) return null;
  const resetsAt = isoTimestamp(input.end);
  if (!resetsAt) return null;

  const boost =
    input.boostPermille !== undefined && input.boostPermille > 0 ? input.boostPermille / 1000 : 1;
  const startsAt = isoTimestamp(input.start);
  return {
    id: input.id,
    remainingPercent: input.status === 2 ? 0 : input.percent * boost,
    resetsAt,
    ...(startsAt ? { startsAt } : {}),
    period: input.period,
  };
}

function normalizeUsage(rows: MiniMaxModelRemains[]): CodingPlanQuotaWindow[] {
  const aggregateRows = rows.filter(row => row.model_name === 'general');
  if (aggregateRows.length !== 1) {
    throw new CodingPlanUsageError('invalid_response');
  }
  const aggregate = aggregateRows[0];
  const windows = [
    quotaWindow({
      id: 'short_term',
      percent: aggregate.current_interval_remaining_percent,
      status: aggregate.current_interval_status,
      start: aggregate.start_time,
      end: aggregate.end_time,
      boostPermille: aggregate.interval_boost_permille,
      period: { unit: 'hour', value: 5 },
    }),
    quotaWindow({
      id: 'weekly',
      percent: aggregate.current_weekly_remaining_percent,
      status: aggregate.current_weekly_status,
      start: aggregate.weekly_start_time,
      end: aggregate.weekly_end_time,
      boostPermille: aggregate.weekly_boost_permille,
      period: { unit: 'week', value: 1 },
    }),
  ].filter((window): window is CodingPlanQuotaWindow => window !== null);
  const result = CodingPlanQuotaWindowsSchema.safeParse(windows);
  if (!result.success) {
    throw new CodingPlanUsageError('invalid_response');
  }
  return result.data;
}

export async function getMiniMaxUsage(apiKey: string) {
  const response = await fetch(MINIMAX_USAGE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(MINIMAX_USAGE_TIMEOUT_MS),
  }).catch(() => {
    throw new CodingPlanUsageError('network');
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CodingPlanUsageError('http');
  }

  const json: unknown = await response.json().catch(() => {
    throw new CodingPlanUsageError('invalid_response');
  });
  const result = MiniMaxUsageResponseSchema.safeParse(json);
  if (!result.success) {
    throw new CodingPlanUsageError('invalid_response');
  }
  if (result.data.base_resp.status_code !== 0) {
    throw new CodingPlanUsageError('application');
  }
  return {
    fetchedAt: new Date().toISOString(),
    windows: normalizeUsage(result.data.model_remains ?? []),
  };
}
