import { queryOptions } from '@tanstack/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
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
  inferRouterOutputs<RootRouter>['admin']['gatewayUsage']['getHourlyUsage'][number];

export type GatewayUsageProgress = {
  hourStart: string;
  completedHours: number;
  totalHours: number;
};

export type GatewayUsageReport = {
  rows: GatewayUsageRow[];
  progress: GatewayUsageProgress;
};

type FetchGatewayUsageHour = (
  input: inferRouterInputs<RootRouter>['admin']['gatewayUsage']['getHourlyUsage'],
  signal: AbortSignal
) => Promise<GatewayUsageRow[]>;

export async function queryGatewayUsageRange(
  input: GatewayUsageRangeInput,
  options: {
    signal: AbortSignal;
    fetchHour: FetchGatewayUsageHour;
    onProgress: (report: GatewayUsageReport) => void;
  }
): Promise<GatewayUsageReport> {
  const { startDate, endDate, model } = GatewayUsageRangeSchema.parse(input);
  const { signal, fetchHour, onProgress } = options;
  signal.throwIfAborted();

  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T23:00:00.000Z`);
  const hourMilliseconds = 3_600_000;
  const totalHours = (end - start) / hourMilliseconds + 1;
  let report: GatewayUsageReport = {
    rows: [],
    progress: { hourStart: `${startDate}T00:00:00.000Z`, completedHours: 0, totalHours },
  };

  for (let timestamp = start; timestamp <= end; timestamp += hourMilliseconds) {
    signal.throwIfAborted();
    const hour = new Date(timestamp);
    const hourStart = hour.toISOString();
    report = { ...report, progress: { ...report.progress, hourStart } };
    onProgress(report);
    signal.throwIfAborted();

    let hourRows: GatewayUsageRow[];
    try {
      hourRows = await fetchHour(
        { date: hourStart.slice(0, 10), hour: hour.getUTCHours(), model },
        signal
      );
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
        `Failed to fetch gateway usage for ${hourStart}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    signal.throwIfAborted();

    report = {
      rows: [...report.rows, ...hourRows],
      progress: { hourStart, completedHours: report.progress.completedHours + 1, totalHours },
    };
    onProgress(report);
    signal.throwIfAborted();
  }

  return report;
}

export function gatewayUsageRangeQueryOptions(
  input: GatewayUsageRangeInput | null,
  fetchHour: FetchGatewayUsageHour
) {
  return queryOptions({
    queryKey: ['admin-gateway-usage-hourly-range', input] as const,
    queryFn: ({ client, queryKey, signal }) => {
      const range = queryKey[1];
      if (range === null) throw new Error('Gateway usage range is required');
      return queryGatewayUsageRange(range, {
        signal,
        fetchHour,
        onProgress: snapshot => client.setQueryData(queryKey, snapshot),
      });
    },
    enabled: input !== null,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
}

export const GATEWAY_USAGE_COLUMNS = [
  'hour_start',
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
