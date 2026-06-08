import { csvField, downloadCsv } from '@/lib/admin-csv';
import {
  DIMENSION_LABELS,
  type CostSource,
  type Dimension,
  type Granularity,
  type PeriodOption,
  type UsageTable,
} from './types';

type UsageTableRow = UsageTable['rows'][number];

/**
 * Prefixes values that could be interpreted as formulas by spreadsheet
 * applications (CSV injection). Leading single-quote forces plain-text
 * rendering in Excel/Google Sheets.
 */
function escapeCsvFormula(value: string): string {
  if (/^[=+\-@\t\r\n]/.test(value)) return `'${value}`;
  return value;
}

/**
 * Render the bucket datetime for CSV. Hourly buckets keep the full ISO
 * timestamp; coarser buckets are trimmed to the relevant prefix so the
 * value stays readable and sorts lexically as chronologically in a
 * spreadsheet.
 */
function datetimeForCsv(isoValue: string, granularity: Granularity): string {
  switch (granularity) {
    case 'hour':
      return isoValue;
    case 'day':
    case 'week':
      return isoValue.slice(0, 10);
    case 'month':
      return isoValue.slice(0, 7);
  }
}

function datetimeHeaderFor(granularity: Granularity): string {
  switch (granularity) {
    case 'hour':
      return 'Hour';
    case 'week':
      return 'Week';
    case 'month':
      return 'Month';
    case 'day':
      return 'Date';
  }
}

function buildFilename(period: PeriodOption, groupBy: Dimension[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const groupSuffix = groupBy.length > 0 ? `-by-${groupBy.join('-')}` : '';
  return `usage-${period}${groupSuffix}-${today}.csv`;
}

type ExportArgs = {
  rows: UsageTableRow[];
  groupBy: Dimension[];
  granularity: Granularity;
  period: PeriodOption;
  costSource: CostSource;
  labelForDimensionValue: (dim: Dimension, value: string) => string;
};

/**
 * Build and download the "Detailed Breakdown" CSV matching the columns the
 * user currently sees in the usage table. Cost is emitted as a raw dollar
 * amount and token/request counts as raw integers, so the CSV is immediately
 * usable for spreadsheet analysis without having to undo human-readable
 * formatting.
 */
export function exportUsageTableToCsv({
  rows,
  groupBy,
  granularity,
  period,
  costSource,
  labelForDimensionValue,
}: ExportArgs): void {
  if (rows.length === 0) return;

  const headers = [
    datetimeHeaderFor(granularity),
    ...groupBy.map(d => DIMENSION_LABELS[d]),
    costSource === 'market' ? 'Estimated Market Cost (USD)' : 'Cost (USD)',
    'Requests',
    'Input Tokens',
    'Output Tokens',
  ];

  const lines: string[] = [headers.map(csvField).join(',')];
  for (const row of rows) {
    const dims = row.dimensions ?? {};
    const values: string[] = [
      datetimeForCsv(row.datetime, granularity),
      ...groupBy.map(d => {
        const raw = dims[d] ?? '';
        return raw ? escapeCsvFormula(labelForDimensionValue(d, raw)) : '';
      }),
      Number((row.costMicrodollars / 1_000_000).toFixed(6)).toString(),
      String(row.requestCount ?? 0),
      String(row.inputTokens ?? 0),
      String(row.outputTokens ?? 0),
    ];
    lines.push(values.map(csvField).join(','));
  }

  downloadCsv(lines.join('\n'), buildFilename(period, groupBy));
}
