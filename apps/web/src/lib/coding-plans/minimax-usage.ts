import 'server-only';

import * as z from 'zod';

import {
  CodingPlanQuotaWindowsSchema,
  type CodingPlanQuotaWindow,
} from '@/lib/coding-plans/usage-contract';

const MINIMAX_USAGE_URL = 'https://api.minimax.io/v1/token_plan/remains';
const MINIMAX_USAGE_TIMEOUT_MS = 5_000;
const MINIMAX_USAGE_MAX_BYTES = 64 * 1024;

const NativePercentSchema = z.number().finite().min(0).max(100);
const NativeIntegerSchema = z.number().int().safe();

const MiniMaxModelRemainsSchema = z.object({
  model_name: z.string().min(1).max(128),
  current_interval_total_count: NativeIntegerSchema.nonnegative().optional(),
  current_interval_usage_count: NativeIntegerSchema.nonnegative().optional(),
  start_time: NativeIntegerSchema.nonnegative().optional(),
  end_time: NativeIntegerSchema.nonnegative().optional(),
  remains_time: NativeIntegerSchema.nonnegative().optional(),
  interval_boost_permill: NativeIntegerSchema.nonnegative().optional(),
  interval_boost_permille: NativeIntegerSchema.nonnegative().optional(),
  current_interval_remaining_percent: NativePercentSchema.optional(),
  current_interval_status: NativeIntegerSchema.optional(),
  current_weekly_total_count: NativeIntegerSchema.nonnegative().optional(),
  current_weekly_usage_count: NativeIntegerSchema.nonnegative().optional(),
  weekly_start_time: NativeIntegerSchema.nonnegative().optional(),
  weekly_end_time: NativeIntegerSchema.nonnegative().optional(),
  weekly_remains_time: NativeIntegerSchema.nonnegative().optional(),
  weekly_boost_permill: NativeIntegerSchema.nonnegative().optional(),
  weekly_boost_permille: NativeIntegerSchema.nonnegative().optional(),
  current_weekly_remaining_percent: NativePercentSchema.optional(),
  current_weekly_status: NativeIntegerSchema.optional(),
});

const MiniMaxBaseResponseSchema = z.object({
  base_resp: z.object({
    status_code: NativeIntegerSchema,
  }),
});

const MiniMaxUsageNativeSchema = MiniMaxBaseResponseSchema.extend({
  model_remains: z.array(MiniMaxModelRemainsSchema).max(64),
});

type MiniMaxUsageNative = z.infer<typeof MiniMaxUsageNativeSchema>;

type MiniMaxUsageErrorCode =
  | 'network'
  | 'http'
  | 'too_large'
  | 'invalid_json'
  | 'invalid_schema'
  | 'application';

export class MiniMaxUsageError extends Error {
  readonly code: MiniMaxUsageErrorCode;

  constructor(code: MiniMaxUsageErrorCode) {
    super('MiniMax usage is temporarily unavailable.');
    this.name = 'MiniMaxUsageError';
    this.code = code;
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MINIMAX_USAGE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new MiniMaxUsageError('too_large');
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MINIMAX_USAGE_MAX_BYTES) {
      throw new MiniMaxUsageError('too_large');
    }
    return new TextDecoder().decode(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;

      size += chunk.value.byteLength;
      if (size > MINIMAX_USAGE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new MiniMaxUsageError('too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function isoTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resetTimestamp(
  end: number | undefined,
  remains: number | undefined,
  fetchedAt: string
): string | undefined {
  const absolute = isoTimestamp(end);
  if (absolute) return absolute;
  if (remains === undefined || remains <= 0) return undefined;
  return isoTimestamp(Date.parse(fetchedAt) + remains);
}

function quotaWindow(input: {
  id: 'short_term' | 'weekly';
  percent: number | undefined;
  status: number | undefined;
  start: number | undefined;
  end: number | undefined;
  remains: number | undefined;
  boostPermille: number | undefined;
  period: CodingPlanQuotaWindow['period'];
  fetchedAt: string;
}): CodingPlanQuotaWindow | null {
  if (input.status === 3 || input.percent === undefined) return null;
  const resetsAt = resetTimestamp(input.end, input.remains, input.fetchedAt);
  if (!resetsAt) return null;

  const boost =
    input.boostPermille !== undefined && input.boostPermille > 0 ? input.boostPermille / 1000 : 1;
  if (!Number.isFinite(boost) || boost < 0) return null;

  const startsAt = isoTimestamp(input.start);
  return {
    id: input.id,
    remainingPercent: input.status === 2 ? 0 : input.percent * boost,
    resetsAt,
    ...(startsAt ? { startsAt } : {}),
    period: input.period,
  };
}

function normalizeUsage(native: MiniMaxUsageNative, fetchedAt: string): CodingPlanQuotaWindow[] {
  const aggregateRows = native.model_remains.filter(row => row.model_name === 'general');
  if (aggregateRows.length !== 1) {
    throw new MiniMaxUsageError('invalid_schema');
  }
  const aggregate = aggregateRows[0];
  const windows = [
    quotaWindow({
      id: 'short_term',
      percent: aggregate.current_interval_remaining_percent,
      status: aggregate.current_interval_status,
      start: aggregate.start_time,
      end: aggregate.end_time,
      remains: aggregate.remains_time,
      boostPermille: aggregate.interval_boost_permille ?? aggregate.interval_boost_permill,
      period: { unit: 'hour', value: 5 },
      fetchedAt,
    }),
    quotaWindow({
      id: 'weekly',
      percent: aggregate.current_weekly_remaining_percent,
      status: aggregate.current_weekly_status,
      start: aggregate.weekly_start_time,
      end: aggregate.weekly_end_time,
      remains: aggregate.weekly_remains_time,
      boostPermille: aggregate.weekly_boost_permille ?? aggregate.weekly_boost_permill,
      period: { unit: 'week', value: 1 },
      fetchedAt,
    }),
  ].filter((window): window is CodingPlanQuotaWindow => window !== null);
  const result = CodingPlanQuotaWindowsSchema.safeParse(windows);
  if (!result.success) {
    throw new MiniMaxUsageError('invalid_schema');
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
    throw new MiniMaxUsageError('network');
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new MiniMaxUsageError('http');
  }

  const text = await readBoundedText(response).catch(error => {
    if (error instanceof MiniMaxUsageError) throw error;
    throw new MiniMaxUsageError('network');
  });
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      throw new MiniMaxUsageError('invalid_json');
    }
  })();
  const baseResponse = MiniMaxBaseResponseSchema.safeParse(json);
  if (!baseResponse.success) {
    throw new MiniMaxUsageError('invalid_schema');
  }
  if (baseResponse.data.base_resp.status_code !== 0) {
    throw new MiniMaxUsageError('application');
  }
  const result = MiniMaxUsageNativeSchema.safeParse(json);
  if (!result.success) {
    throw new MiniMaxUsageError('invalid_schema');
  }
  const fetchedAt = new Date().toISOString();
  return {
    fetchedAt,
    windows: normalizeUsage(result.data, fetchedAt),
  };
}
