import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

export type MonthlyUsageRow =
  inferRouterOutputs<RootRouter>['admin']['gatewayUsage']['getMonthlyUsage'][number];

export const MONTHLY_USAGE_COLUMNS = [
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
] as const satisfies readonly (keyof MonthlyUsageRow)[];

function spreadsheetProvider(value: string | null): string {
  if (value === null) return '';
  const singleLine = value.replace(/[\t\r\n]/g, ' ');
  const safe = /^\s*[=+\-@]/.test(singleLine) ? `'${singleLine}` : singleLine;
  return safe.includes('"') ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function monthlyUsageToTsv(rows: MonthlyUsageRow[]): string {
  return [
    MONTHLY_USAGE_COLUMNS.join('\t'),
    ...rows.map(row =>
      MONTHLY_USAGE_COLUMNS.map(column =>
        column === 'provider' ? spreadsheetProvider(row.provider) : String(row[column] ?? '')
      ).join('\t')
    ),
  ].join('\n');
}
