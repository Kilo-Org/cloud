import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeBinding,
  type SnowflakeRow,
} from '@/lib/snowflake';
import { timedSnowflakeQuery } from '@/routers/usage-analytics-router';

export const AI_REQUESTS_PAGE_SIZE = 50;
export const AI_REQUESTS_MAX_RANGE_DAYS = 31;
const DAY_MS = 86_400_000;
const QUERY_TIMEOUT_MS = 10_000;

const DEFAULT_REQUESTS_TABLE = 'KILO_INTERMEDIATE.INT_MICRODOLLAR_USAGE__ENRICHED';
const SNOWFLAKE_IDENTIFIER_PATH = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/;

export function resolveRequestsTable(): string {
  const configured = getEnvVariable('SNOWFLAKE_AI_REQUESTS_TABLE');
  if (!configured) return DEFAULT_REQUESTS_TABLE;
  if (!SNOWFLAKE_IDENTIFIER_PATH.test(configured)) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Usage data unavailable' });
  }
  return configured;
}

const SNOWFLAKE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export const AiRequestsCursorSchema = z.object({
  createdAt: z.string().regex(SNOWFLAKE_TIMESTAMP),
  id: z.uuid(),
});

export const KeySourceFilterSchema = z.enum(['all', 'user_byok', 'kilo']);

export const ListAiRequestsInputSchema = z
  .object({
    startDate: z.iso.datetime(),
    endDate: z.iso.datetime(),
    keySource: KeySourceFilterSchema.default('all'),
    cursor: AiRequestsCursorSchema.nullish(),
  })
  .refine(input => Date.parse(input.startDate) < Date.parse(input.endDate), {
    message: 'startDate must be before endDate',
  })
  .refine(
    input =>
      Date.parse(input.endDate) - Date.parse(input.startDate) <=
      AI_REQUESTS_MAX_RANGE_DAYS * DAY_MS,
    { message: `Date range cannot exceed ${AI_REQUESTS_MAX_RANGE_DAYS} days` }
  );

export type ListAiRequestsInput = z.input<typeof ListAiRequestsInputSchema>;

export type AiRequestKeySource = 'user_byok' | 'kilo' | 'unknown';

export type AiRequestRow = {
  id: string;
  createdAt: string;
  model: string | null;
  requestedModel: string | null;
  provider: string | null;
  feature: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
  costMicrodollars: string;
  keySource: AiRequestKeySource;
  hasError: boolean | null;
};

const COLUMNS = [
  'ID',
  `TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"')`,
  'MODEL',
  'REQUESTED_MODEL',
  'COALESCE(INFERENCE_PROVIDER, PROVIDER)',
  'FEATURE',
  'INPUT_TOKENS',
  'OUTPUT_TOKENS',
  'CACHE_WRITE_TOKENS',
  'CACHE_HIT_TOKENS',
  'COST',
  'IS_USER_BYOK',
  'HAS_ERROR',
] as const;

export function buildAiRequestsQuery(
  table: string,
  userId: string,
  input: z.output<typeof ListAiRequestsInputSchema>
): { statement: string; bindings: SnowflakeBinding[] } {
  const text = (value: string): SnowflakeBinding => ({ type: 'TEXT', value });
  // ORIGINAL_KILO_USER_ID is the backend user id written by the gateway. KILO_USER_ID is
  // rewritten by anonymous-identity resolution, so scoping on it could match other identities.
  const clauses = [
    'ORIGINAL_KILO_USER_ID = ?',
    "(ORGANIZATION_ID IS NULL OR ORGANIZATION_ID = '')",
    'CREATED_AT >= ?',
    'CREATED_AT < ?',
  ];
  const bindings = [text(userId), text(input.startDate), text(input.endDate)];

  if (input.keySource === 'user_byok') clauses.push('IS_USER_BYOK = TRUE');
  if (input.keySource === 'kilo') clauses.push('IS_USER_BYOK = FALSE');

  if (input.cursor) {
    clauses.push('(CREATED_AT < ? OR (CREATED_AT = ? AND ID < ?))');
    bindings.push(
      text(input.cursor.createdAt),
      text(input.cursor.createdAt),
      text(input.cursor.id)
    );
  }

  return {
    statement: `SELECT ${COLUMNS.join(', ')}
FROM ${table}
WHERE ${clauses.join('\n  AND ')}
ORDER BY CREATED_AT DESC, ID DESC
LIMIT ${AI_REQUESTS_PAGE_SIZE + 1}`,
    bindings,
  };
}

const MICRODOLLARS = /^-?\d+$/;

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function tokenCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return null;
}

export function toKeySource(isUserByok: unknown): AiRequestKeySource {
  const flag = nullableBoolean(isUserByok);
  if (flag === null) return 'unknown';
  return flag ? 'user_byok' : 'kilo';
}

export function parseAiRequestRow(row: SnowflakeRow): AiRequestRow {
  const [id, createdAt, model, requestedModel, provider, feature, ...rest] = row;
  const [input, output, cacheWrite, cacheHit, cost, isUserByok, hasError] = rest;
  const costText = String(cost ?? '0');
  if (typeof id !== 'string' || typeof createdAt !== 'string' || !MICRODOLLARS.test(costText)) {
    throw new Error('Unexpected AI request row shape');
  }
  return {
    id,
    createdAt,
    model: nullableText(model),
    requestedModel: nullableText(requestedModel),
    provider: nullableText(provider),
    feature: nullableText(feature),
    inputTokens: tokenCount(input),
    outputTokens: tokenCount(output),
    cacheWriteTokens: tokenCount(cacheWrite),
    cacheHitTokens: tokenCount(cacheHit),
    costMicrodollars: costText,
    keySource: toKeySource(isUserByok),
    hasError: nullableBoolean(hasError),
  };
}

export const userAiRequestsRouter = createTRPCRouter({
  list: baseProcedure.input(ListAiRequestsInputSchema).query(async ({ ctx, input }) => {
    if (Date.parse(input.endDate) > Date.now() + DAY_MS) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'endDate cannot be in the future' });
    }
    const config = resolveSnowflakeConfig();
    if (!config) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Usage data unavailable' });
    }
    const { statement, bindings } = buildAiRequestsQuery(
      resolveRequestsTable(),
      ctx.user.id,
      input
    );

    const rows = await timedSnowflakeQuery(
      {
        route: 'userAiRequests.list',
        queryLabel: 'ai_requests',
        scope: 'user',
        period: null,
        timeoutMs: QUERY_TIMEOUT_MS,
      },
      async signal =>
        (
          await executeSnowflakeStatement({
            config,
            statement,
            bindings,
            timeoutSeconds: QUERY_TIMEOUT_MS / 1000,
            signal,
          })
        ).map(parseAiRequestRow)
    );

    const items = rows.slice(0, AI_REQUESTS_PAGE_SIZE);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > AI_REQUESTS_PAGE_SIZE && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }),
});
