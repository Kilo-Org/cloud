'use client';

import { BarChart3 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatDollars,
  formatIsoDateString_UsaDateOnlyFormat,
  formatLargeNumber,
} from '@/lib/utils';
import { ToolCardShell } from './ToolCardShell';
import {
  getKiloDatasetColumnLabel,
  getKiloDatasetFriendlyText,
  getKiloDatasetNameLabel,
  getKiloDatasetScalarValueLabel,
} from './kilo-dataset-display';
import type { RawUsageRenderResult } from './raw-tool-call-markup';

const chartColors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

type RowValue = RawUsageRenderResult['data'][number][string];

function numberFromValue(value: RowValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function labelForValue(value: RowValue, columnName = ''): string {
  const scalarLabel = getKiloDatasetScalarValueLabel(columnName, value);
  if (scalarLabel) return scalarLabel;
  return String(value);
}

function formatMaybeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  return formatIsoDateString_UsaDateOnlyFormat(value);
}

function isDateLike(value: RowValue): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);
}

function labelColumnDisplayName(result: RawUsageRenderResult, labelKey: string): string {
  if (labelKey === 'label' && result.data.some(row => isDateLike(row[labelKey]))) return 'Date';
  return getKiloDatasetColumnLabel(labelKey, result.dataset);
}

function formatMetricValue(metric: string | undefined, value: number): string {
  const lowerMetric = metric?.toLowerCase() ?? '';
  if (lowerMetric.includes('costusd')) return formatDollars(value);
  if (lowerMetric.includes('costmicrodollars')) return formatDollars(value / 1_000_000);
  return formatLargeNumber(value);
}

function resolveMetricKey(result: RawUsageRenderResult): string | undefined {
  if (
    result.metric &&
    result.data.some(row => numberFromValue(row[result.metric ?? '']) !== null)
  ) {
    return result.metric;
  }

  const firstRow = result.data[0];
  if (!firstRow) return undefined;
  return Object.keys(firstRow).find(key => numberFromValue(firstRow[key]) !== null);
}

function resolveLabelKey(
  result: RawUsageRenderResult,
  metricKey: string | undefined
): string | undefined {
  const firstRow = result.data[0];
  if (!firstRow) return undefined;
  return Object.keys(firstRow).find(key => key !== metricKey) ?? metricKey;
}

function subtitle(result: RawUsageRenderResult): string {
  return [
    result.dataset ? getKiloDatasetNameLabel(result.dataset) : undefined,
    result.metric ? getKiloDatasetColumnLabel(result.metric, result.dataset) : undefined,
    result.startDate && result.endDate
      ? `${formatMaybeDate(result.startDate)} to ${formatMaybeDate(result.endDate)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

function ResultTable({ result }: { result: RawUsageRenderResult }) {
  const columns = Object.keys(result.data[0] ?? {});
  if (columns.length === 0 || result.data.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="bg-muted/30 text-muted-foreground text-xs">
          <tr>
            {columns.map(column => (
              <th key={column} className="px-3 py-2 font-medium">
                {getKiloDatasetColumnLabel(column, result.dataset)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.data.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t">
              {columns.map(column => {
                const value = row[column];
                const numeric = numberFromValue(value);
                return (
                  <td key={column} className="px-3 py-2 tabular-nums">
                    {numeric !== null
                      ? formatMetricValue(column, numeric)
                      : labelForValue(value, column)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultChart({ result }: { result: RawUsageRenderResult }) {
  const metricKey = resolveMetricKey(result);
  const labelKey = resolveLabelKey(result, metricKey);
  if (!metricKey || !labelKey || result.data.length === 0) {
    return <ResultTable result={result} />;
  }

  const data = result.data.map((row, index) => ({
    label: formatMaybeDate(labelForValue(row[labelKey], labelKey)),
    value: numberFromValue(row[metricKey]) ?? 0,
    color: chartColors[index % chartColors.length],
  }));
  const chartHeight = Math.min(420, Math.max(220, data.length * 42 + 32));

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {getKiloDatasetColumnLabel(metricKey, result.dataset)} by{' '}
        {labelColumnDisplayName(result, labelKey)}
      </p>
      <div className="w-full" style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" stroke="currentColor" fontSize={11} tickMargin={8} />
            <YAxis
              stroke="currentColor"
              fontSize={11}
              tickFormatter={value => formatMetricValue(metricKey, Number(value))}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(17, 24, 39, 0.95)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={value => [formatMetricValue(metricKey, Number(value))]}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map(item => (
                <Cell key={item.label} fill={item.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function AskUsageRawRenderResultCard({ result }: { result: RawUsageRenderResult }) {
  const isChart = result.type === 'chart' || result.chartType !== undefined;

  return (
    <ToolCardShell
      icon={BarChart3}
      title={result.title ? getKiloDatasetFriendlyText(result.title) : 'Usage result'}
      status="completed"
      badge={
        <span className="text-muted-foreground shrink-0 text-xs">
          {isChart ? 'Chart' : 'Table'}
        </span>
      }
      defaultExpanded
    >
      <div className="space-y-3">
        {subtitle(result) && (
          <div className="text-muted-foreground text-xs">{subtitle(result)}</div>
        )}
        {isChart ? <ResultChart result={result} /> : <ResultTable result={result} />}
      </div>
    </ToolCardShell>
  );
}
