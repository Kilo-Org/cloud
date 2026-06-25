'use client';

import { BarChart3, Database } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDollarsFromMicrodollars } from '@/components/usage-analytics/format';
import { GenericToolCard } from '@/components/cloud-agent-next/GenericToolCard';
import { ToolCardShell } from '@/components/cloud-agent-next/ToolCardShell';
import type { ToolPart } from '@/components/cloud-agent-next/types';
import type {
  QueryKiloDatasetColumn,
  QueryKiloDatasetInput,
  QueryKiloDatasetOutput,
} from '@/lib/kilo-datasets/contracts';
import {
  formatDollars,
  formatIsoDateString_UsaDateOnlyFormat,
  formatLargeNumber,
} from '@/lib/utils';
import { resolveAskUsageDatasetToolView, type AskUsageDatasetToolView } from './dataset-tool-view';

type ReadyView = Extract<AskUsageDatasetToolView, { kind: 'ready' }>;
type RowValue = QueryKiloDatasetOutput['rows'][number][string];
type ChartDatum = Record<string, string | number> & { bucketKey: string; bucketLabel: string };
type DatasetName = QueryKiloDatasetOutput['dataset'];
type DatasetMode = QueryKiloDatasetOutput['mode'];
type MetricOperation = QueryKiloDatasetInput['metrics'][number]['operation'];
type ScalarValue = string | number | boolean | null;

const chartColors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

const datasetLabels: Record<string, string> = {
  microdollar_usage: 'Model usage',
  code_reviews: 'Code Reviewer',
  cloud_sessions: 'Cloud Agent sessions',
  cli_sessions: 'CLI sessions',
  vscode_sessions: 'VS Code sessions',
} satisfies Record<DatasetName, string>;

const modeLabels: Record<string, string> = {
  aggregate: 'Breakdown',
  timeseries: 'Trend',
} satisfies Record<DatasetMode, string>;

const renderModeLabels: Record<string, string> = {
  'metric-grid': 'Summary',
  'bar-chart': 'Breakdown',
  'timeseries-chart': 'Trend',
  table: 'Table',
} satisfies Record<ReadyView['renderMode'], string>;

const operationLabels: Record<string, string> = {
  count: 'Count',
  countDistinct: 'Unique',
  sum: 'Total',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
} satisfies Record<MetricOperation, string>;

const fieldLabels: Record<string, string> = {
  agentVersion: 'Agent version',
  bucketStart: 'Date',
  cacheHitTokens: 'Cache hit tokens',
  cacheWriteTokens: 'Cache write tokens',
  completedAt: 'Completed at',
  costMicrodollars: 'Cost',
  costUsd: 'Cost',
  createdAt: 'Date',
  gitBranch: 'Branch',
  gitUrl: 'Git remote',
  hasError: 'Result',
  inferenceProvider: 'Inference provider',
  inputTokens: 'Input tokens',
  isRoot: 'Session type',
  label: 'Label',
  lastMode: 'Last mode',
  lastModel: 'Last model',
  model: 'Model',
  organizationId: 'Organization',
  outputTokens: 'Output tokens',
  platform: 'Platform',
  projectId: 'Project',
  provider: 'Provider',
  repository: 'Repository',
  repositoryReviewInstructionsUsed: 'Repository instructions',
  sourceVersion: 'Source version',
  startedAt: 'Started at',
  status: 'Status',
  terminalReason: 'Completion reason',
  totalCostMicrodollars: 'Cost',
  totalCostUsd: 'Cost',
  totalInputTokens: 'Input tokens',
  totalOutputTokens: 'Output tokens',
  updatedAt: 'Updated at',
  version: 'Version',
};

function fallbackLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function countLabel(dataset: string | undefined): string {
  if (dataset === 'code_reviews') return 'Reviews';
  if (dataset === 'cloud_sessions' || dataset === 'cli_sessions' || dataset === 'vscode_sessions') {
    return 'Sessions';
  }
  return 'Requests';
}

function getAskUsageDatasetNameLabel(dataset: string | undefined): string {
  if (!dataset) return 'Usage result';
  return datasetLabels[dataset] ?? fallbackLabel(dataset);
}

function getAskUsageDatasetModeLabel(mode: string): string {
  return modeLabels[mode] ?? fallbackLabel(mode);
}

function getAskUsageDatasetRenderModeLabel(mode: string): string {
  return renderModeLabels[mode] ?? fallbackLabel(mode);
}

function metricLabel(operation: string, field: string): string {
  const fieldLabel = getAskUsageDatasetColumnLabel(field);
  if (operation === 'sum') return fieldLabel;
  const operationLabel = operationLabels[operation] ?? fallbackLabel(operation);
  return `${operationLabel} ${lowerFirst(fieldLabel)}`;
}

function metricAliasLabel(columnName: string): string | undefined {
  const separatorIndex = columnName.indexOf('_');
  if (separatorIndex === -1) return undefined;

  const operation = columnName.slice(0, separatorIndex);
  if (!operationLabels[operation]) return undefined;

  const field = columnName.slice(separatorIndex + 1);
  if (!field) return undefined;
  return metricLabel(operation, field);
}

function getAskUsageDatasetColumnLabel(
  columnName: string,
  dataset: string | undefined = undefined
): string {
  if (columnName === 'count') return countLabel(dataset);
  return metricAliasLabel(columnName) ?? fieldLabels[columnName] ?? fallbackLabel(columnName);
}

function getAskUsageDatasetScalarValueLabel(
  columnName: string,
  value: ScalarValue
): string | undefined {
  if (value === null) return 'No data';
  if (typeof value !== 'boolean') return undefined;

  if (columnName === 'hasError') return value ? 'Errored' : 'Successful';
  if (columnName === 'isRoot') return value ? 'Root session' : 'Child session';
  if (columnName === 'repositoryReviewInstructionsUsed') return value ? 'Used' : 'Not used';
  return value ? 'Yes' : 'No';
}

function numberFromValue(value: RowValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function labelForValue(column: QueryKiloDatasetColumn, value: RowValue): string {
  const scalarLabel = getAskUsageDatasetScalarValueLabel(column.name, value);
  if (scalarLabel) return scalarLabel;
  return String(value);
}

function formatColumnValue(column: QueryKiloDatasetColumn, value: RowValue): string {
  const scalarLabel = getAskUsageDatasetScalarValueLabel(column.name, value);
  if (scalarLabel) return scalarLabel;
  if (column.type === 'timestamp') return formatIsoDateString_UsaDateOnlyFormat(String(value));
  const numeric = numberFromValue(value);
  if (numeric !== null) {
    const lowerName = column.name.toLowerCase();
    if (lowerName.includes('costmicrodollars')) return formatDollarsFromMicrodollars(numeric);
    if (lowerName.includes('costusd')) return formatDollars(numeric);
    if (column.type === 'integer') return formatLargeNumber(numeric);
    if (column.type === 'decimal') {
      return numeric.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
  }
  return String(value);
}

function rowKey(columns: QueryKiloDatasetColumn[], row: QueryKiloDatasetOutput['rows'][number]) {
  return columns.map(column => `${column.name}:${String(row[column.name])}`).join('|');
}

function formatBucketLabel(value: RowValue, bucket: ReadyView['input']['bucket']): string {
  if (typeof value !== 'string' && typeof value !== 'number') return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  if (bucket === 'hour') {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(date);
  }
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
  return bucket === 'week' ? `Week of ${dateLabel}` : dateLabel;
}

function MetricGrid({ view }: { view: ReadyView }) {
  const row = view.output.rows[0];
  if (!row) return <p className="text-muted-foreground text-sm">No data for this query.</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {view.metricColumns.map(column => (
        <div key={column.name} className="rounded-lg border bg-background/50 p-3">
          <div className="text-muted-foreground text-xs">
            {getAskUsageDatasetColumnLabel(column.name, view.output.dataset)}
          </div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatColumnValue(column, row[column.name])}
          </div>
        </div>
      ))}
    </div>
  );
}

function TableView({ view }: { view: ReadyView }) {
  if (view.output.rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-max text-left text-sm">
        <thead className="bg-muted/30 text-muted-foreground text-xs">
          <tr>
            {view.output.columns.map(column => (
              <th key={column.name} className="px-3 py-2 font-medium">
                {getAskUsageDatasetColumnLabel(column.name, view.output.dataset)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.output.rows.map(row => (
            <tr key={rowKey(view.output.columns, row)} className="border-t">
              {view.output.columns.map(column => (
                <td key={column.name} className="px-3 py-2 tabular-nums">
                  {formatColumnValue(column, row[column.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ViewDataDisclosure({ view }: { view: ReadyView }) {
  return (
    <details className="group rounded-lg border bg-background/30">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-3 py-2 text-xs font-medium transition-colors">
        View data
      </summary>
      <div className="border-t p-3">
        <TableView view={view} />
      </div>
    </details>
  );
}

function JsonDetails({ view }: { view: ReadyView }) {
  return (
    <details className="rounded-lg border bg-background/30">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-3 py-2 text-xs font-medium transition-colors">
        Validated JSON
      </summary>
      <pre className="max-h-80 overflow-auto border-t p-3 text-xs">
        <code>{JSON.stringify(view.output, null, 2)}</code>
      </pre>
    </details>
  );
}

function BarChartView({ view }: { view: ReadyView }) {
  const groupColumn = view.groupColumns[0];
  const metricColumn = view.metricColumns[0];
  if (!groupColumn || !metricColumn || view.output.rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }

  const data = view.output.rows.map(row => {
    const groupValue = row[groupColumn.name];
    return {
      key: `${groupColumn.name}:${String(groupValue)}`,
      label: labelForValue(groupColumn, groupValue),
      value: numberFromValue(row[metricColumn.name]) ?? 0,
    };
  });
  const longestLabel = data.reduce((max, item) => Math.max(max, item.label.length), 0);
  const yAxisWidth = Math.min(220, Math.max(96, longestLabel * 7 + 16));
  const chartHeight = Math.min(420, Math.max(180, data.length * 36 + 24));
  const chartLabel = `${getAskUsageDatasetColumnLabel(metricColumn.name, view.output.dataset)} by ${getAskUsageDatasetColumnLabel(groupColumn.name, view.output.dataset)}`;

  return (
    <figure className="space-y-2" aria-label={chartLabel}>
      <figcaption className="text-muted-foreground text-xs">{chartLabel}</figcaption>
      <div className="w-full" style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            accessibilityLayer
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              type="number"
              stroke="currentColor"
              fontSize={11}
              tickFormatter={value => formatColumnValue(metricColumn, Number(value))}
            />
            <YAxis
              dataKey="label"
              type="category"
              stroke="currentColor"
              fontSize={11}
              width={yAxisWidth}
              tickMargin={8}
              tick={{ fill: 'currentColor' }}
              interval={0}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(17, 24, 39, 0.95)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                fontSize: 12,
              }}
              cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
              formatter={value => [formatColumnValue(metricColumn, Number(value))]}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((item, index) => (
                <Cell key={item.key} fill={chartColors[index % chartColors.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function buildTimeseriesData(view: ReadyView) {
  const metricColumn = view.metricColumns[0];
  const groupColumn = view.groupColumns[0];
  if (!metricColumn)
    return {
      data: [] as ChartDatum[],
      seriesKeys: [] as string[],
      seriesLabels: new Map<string, string>(),
    };

  if (!groupColumn) {
    return {
      data: view.output.rows.map(row => {
        const bucketValue = row.bucketStart;
        return {
          bucketKey: String(bucketValue),
          bucketLabel: formatBucketLabel(bucketValue, view.input.bucket),
          [metricColumn.name]: numberFromValue(row[metricColumn.name]) ?? 0,
        };
      }),
      seriesKeys: [metricColumn.name],
      seriesLabels: new Map([
        [metricColumn.name, getAskUsageDatasetColumnLabel(metricColumn.name, view.output.dataset)],
      ]),
    };
  }

  const byBucket = new Map<string, ChartDatum>();
  const seriesKeys: string[] = [];
  const seriesLabels = new Map<string, string>();
  for (const row of view.output.rows) {
    const bucketValue = row.bucketStart;
    const bucketKey = String(bucketValue);
    const groupValue = row[groupColumn.name];
    const seriesKey = `${groupColumn.name}:${String(groupValue)}`;
    if (!seriesKeys.includes(seriesKey)) seriesKeys.push(seriesKey);
    seriesLabels.set(seriesKey, labelForValue(groupColumn, groupValue));
    const existing: ChartDatum = byBucket.get(bucketKey) ?? {
      bucketKey,
      bucketLabel: formatBucketLabel(bucketValue, view.input.bucket),
    };
    existing[seriesKey] = numberFromValue(row[metricColumn.name]) ?? 0;
    byBucket.set(bucketKey, existing);
  }
  return { data: [...byBucket.values()], seriesKeys, seriesLabels };
}

function TimeseriesChartView({ view }: { view: ReadyView }) {
  const metricColumn = view.metricColumns[0];
  if (!metricColumn || view.output.rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }
  const { data, seriesKeys, seriesLabels } = buildTimeseriesData(view);
  if (data.length === 0 || seriesKeys.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }
  const chartLabel = `${getAskUsageDatasetColumnLabel(metricColumn.name, view.output.dataset)} over time`;

  return (
    <figure className="space-y-2" aria-label={chartLabel}>
      <figcaption className="text-muted-foreground text-xs">{chartLabel}</figcaption>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            accessibilityLayer
            data={data}
            margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="bucketLabel" stroke="currentColor" fontSize={11} tickMargin={8} />
            <YAxis
              stroke="currentColor"
              fontSize={11}
              tickFormatter={value => formatColumnValue(metricColumn, Number(value))}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(17, 24, 39, 0.95)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value, name) => [
                formatColumnValue(metricColumn, Number(value)),
                seriesLabels.get(String(name)) ?? String(name),
              ]}
            />
            {seriesKeys.map((key, index) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={seriesLabels.get(key) ?? key}
                stroke={chartColors[index % chartColors.length]}
                fill={chartColors[index % chartColors.length]}
                fillOpacity={0.12}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function RenderedResult({ view }: { view: ReadyView }) {
  if (view.renderMode === 'metric-grid') return <MetricGrid view={view} />;
  if (view.renderMode === 'bar-chart') return <BarChartView view={view} />;
  if (view.renderMode === 'timeseries-chart') return <TimeseriesChartView view={view} />;
  return <TableView view={view} />;
}

export function AskUsageDatasetToolCard({ toolPart }: { toolPart: ToolPart }) {
  const view = resolveAskUsageDatasetToolView(toolPart);
  if (view.kind === 'unhandled') return <GenericToolCard toolPart={toolPart} />;

  if (view.kind === 'pending' || view.kind === 'running' || view.kind === 'error') {
    return (
      <ToolCardShell icon={Database} title="Kilo usage" status={view.kind}>
        {view.kind === 'error' ? (
          <pre className="overflow-auto rounded-md bg-background p-2 text-xs text-red-500">
            <code>{view.message}</code>
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {view.kind === 'pending' ? 'Waiting...' : 'Running...'}
          </p>
        )}
      </ToolCardShell>
    );
  }

  const showDataFallback =
    view.renderMode === 'bar-chart' || view.renderMode === 'timeseries-chart';

  return (
    <ToolCardShell
      icon={BarChart3}
      title={getAskUsageDatasetNameLabel(view.output.dataset)}
      status="completed"
      badge={
        <span className="text-muted-foreground shrink-0 text-xs">
          {getAskUsageDatasetRenderModeLabel(view.renderMode)}
        </span>
      }
      defaultExpanded
    >
      <div className="space-y-3">
        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span>{getAskUsageDatasetNameLabel(view.output.dataset)}</span>
          <span>{getAskUsageDatasetModeLabel(view.output.mode)}</span>
          <span>
            {formatIsoDateString_UsaDateOnlyFormat(view.output.range.startDate)} to{' '}
            {formatIsoDateString_UsaDateOnlyFormat(view.output.range.endDate)}
          </span>
        </div>
        <RenderedResult view={view} />
        {showDataFallback && <ViewDataDisclosure view={view} />}
        <JsonDetails view={view} />
      </div>
    </ToolCardShell>
  );
}
