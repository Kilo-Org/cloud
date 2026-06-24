import 'server-only';

import * as z from 'zod';

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

export const MiniMaxUsageNativeSchema = z.object({
  base_resp: z.object({
    status_code: NativeIntegerSchema,
  }),
  model_remains: z.array(MiniMaxModelRemainsSchema).max(64),
});

export type MiniMaxUsageNative = z.infer<typeof MiniMaxUsageNativeSchema>;

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

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function getMiniMaxUsage(apiKey: string): Promise<MiniMaxUsageNative> {
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
    response.body?.cancel().catch(() => undefined);
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
  const result = MiniMaxUsageNativeSchema.safeParse(json);
  if (!result.success) {
    throw new MiniMaxUsageError('invalid_schema');
  }
  if (result.data.base_resp.status_code !== 0) {
    throw new MiniMaxUsageError('application');
  }
  return result.data;
}
