import type { inferRouterOutputs } from '@trpc/server';
import * as z from 'zod';
import type { RootRouter } from '@/routers/root-router';

const UsageDateSchema = z.iso
  .date()
  .length(10)
  .refine(date => date >= '2000-01-01' && date <= '9999-12-31', {
    message: 'Date must be between 2000-01-01 and 9999-12-31',
  });

export const GatewayUsageRangeSchema = z
  .object({
    startDate: UsageDateSchema,
    endDate: UsageDateSchema,
    model: z.string().trim().min(1).max(256),
  })
  .refine(input => input.startDate <= input.endDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  });

export type GatewayUsageRangeInput = z.infer<typeof GatewayUsageRangeSchema>;

export type GatewayUsageRow =
  inferRouterOutputs<RootRouter>['admin']['gatewayUsage']['getDailyUsage'][number];

export type GatewayUsageProgress = {
  date: string;
  completedDays: number;
  totalDays: number;
};

export async function queryGatewayUsageRange(
  input: GatewayUsageRangeInput,
  options: {
    signal: AbortSignal;
    fetchDay: (
      input: { date: string; model: string },
      signal: AbortSignal
    ) => Promise<GatewayUsageRow[]>;
    onProgress: (progress: GatewayUsageProgress) => void;
  }
): Promise<GatewayUsageRow[]> {
  const { startDate, endDate, model } = GatewayUsageRangeSchema.parse(input);
  const { signal, fetchDay, onProgress } = options;
  signal.throwIfAborted();

  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const dayMilliseconds = 86_400_000;
  const totalDays = (end - start) / dayMilliseconds + 1;
  const rows: GatewayUsageRow[] = [];
  let completedDays = 0;

  for (let timestamp = start; timestamp <= end; timestamp += dayMilliseconds) {
    signal.throwIfAborted();
    const date = new Date(timestamp).toISOString().slice(0, 10);
    onProgress({ date, completedDays, totalDays });
    signal.throwIfAborted();

    let dayRows: GatewayUsageRow[];
    try {
      dayRows = await fetchDay({ date, model }, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
      ) {
        throw error;
      }
      throw new Error(
        `Failed to fetch gateway usage for ${date}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    signal.throwIfAborted();

    for (const row of dayRows) rows.push(row);
    completedDays += 1;
    onProgress({ date, completedDays, totalDays });
  }

  signal.throwIfAborted();
  return rows;
}

export const GATEWAY_USAGE_COLUMNS = [
  'date',
  'provider',
  'is_byok',
  'users',
  'logged_in_users',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost',
  'market_cost',
] as const satisfies readonly (keyof GatewayUsageRow)[];

function spreadsheetProvider(value: string | null): string {
  if (value === null) return '';
  const singleLine = value.replace(/[\t\r\n]/g, ' ');
  const safe = /^\s*[=+\-@]/.test(singleLine) ? `'${singleLine}` : singleLine;
  return safe.includes('"') ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function gatewayUsageToTsv(rows: GatewayUsageRow[]): string {
  return [
    GATEWAY_USAGE_COLUMNS.join('\t'),
    ...rows.map(row =>
      GATEWAY_USAGE_COLUMNS.map(column =>
        column === 'provider' ? spreadsheetProvider(row.provider) : String(row[column] ?? '')
      ).join('\t')
    ),
  ].join('\n');
}
