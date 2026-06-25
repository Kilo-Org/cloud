'use client';

import React from 'react';
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
import {
  QueryKiloDatasetInputSchema,
  QueryKiloDatasetOutputSchema,
  type QueryKiloDatasetColumn,
  type QueryKiloDatasetInput,
  type QueryKiloDatasetOutput,
} from '@/lib/kilo-datasets/contracts';
import { formatDollarsFromMicrodollars } from '@/components/usage-analytics/format';
import {
  formatDollars,
  formatIsoDateString_UsaDateOnlyFormat,
  formatLargeNumber,
} from '@/lib/utils';
import { GenericToolCard } from './GenericToolCard';
import { ToolCardShell } from './ToolCardShell';
import {
  getKiloDatasetColumnLabel,
  getKiloDatasetModeLabel,
  getKiloDatasetNameLabel,
  getKiloDatasetRenderModeLabel,
  getKiloDatasetScalarValueLabel,
} from './kilo-dataset-display';
import type { ToolPart } from './types';

export const KILO_DATASET_TOOL_NAME = 'kilo_usage_query_kilo_dataset';

const KILO_DATASET_MCP_SERVER_NAME = 'kilo_usage';
const KILO_DATASET_MCP_TOOL_NAME = 'query_kilo_dataset';

export type KiloDatasetRenderMode = 'metric-grid' | 'bar-chart' | 'timeseries-chart' | 'table';

type RowValue = QueryKiloDatasetOutput['rows'][number][string];

export type KiloDatasetToolView =
  | { kind: 'fallback' }
  | { kind: 'status'; status: 'pending' | 'running' | 'error'; error?: string }
  | {
      kind: 'ready';
      input: QueryKiloDatasetInput;
      output: QueryKiloDatasetOutput;
      renderMode: KiloDatasetRenderMode;
      metricColumns: QueryKiloDatasetColumn[];
      groupColumns: QueryKiloDatasetColumn[];
    };

const chartColors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

function metricAlias(metric: QueryKiloDatasetInput['metrics'][number]): string {
  return metric.operation === 'count' ? 'count' : `${metric.operation}_${metric.field}`;
}

export function isKiloDatasetQueryTool(toolPart: ToolPart): boolean {
  if (toolPart.tool === KILO_DATASET_TOOL_NAME) return true;
  if (toolPart.tool !== 'mcp') return false;

  const input = toolPart.state.input;
  return (
    input.server_name === KILO_DATASET_MCP_SERVER_NAME &&
    input.tool_name === KILO_DATASET_MCP_TOOL_NAME
  );
}

function inputForKiloDatasetQuery(toolPart: ToolPart): unknown {
  if (toolPart.tool !== 'mcp') return toolPart.state.input;
  return toolPart.state.input.arguments;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputCandidateFromMcpResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.structuredContent !== undefined) return value.structuredContent;

  if (!Array.isArray(value.content)) return value;
  for (const item of value.content) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
    const parsedText = parseJson(item.text);
    if (parsedText !== undefined) return parsedText;
  }
  return value;
}

function parseKiloDatasetOutput(output: string): unknown {
  const parsed = parseJson(output);
  if (parsed === undefined) return undefined;
  return outputCandidateFromMcpResult(parsed);
}

function columnByName(output: QueryKiloDatasetOutput): Map<string, QueryKiloDatasetColumn> {
  return new Map(output.columns.map(column => [column.name, column]));
}

function metricColumnsForInput(
  input: QueryKiloDatasetInput,
  output: QueryKiloDatasetOutput
): QueryKiloDatasetColumn[] {
  const columns = columnByName(output);
  return input.metrics.flatMap(metric => {
    const column = columns.get(metricAlias(metric));
    return column ? [column] : [];
  });
}

function groupColumnsForInput(
  input: QueryKiloDatasetInput,
  output: QueryKiloDatasetOutput
): QueryKiloDatasetColumn[] {
  const columns = columnByName(output);
  return (input.groupBy ?? []).flatMap(name => {
    const column = columns.get(name);
    return column ? [column] : [];
  });
}

function numberFromValue(value: RowValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function allRowsHaveNumericValue(output: QueryKiloDatasetOutput, columnName: string): boolean {
  return output.rows.every(
    row => row[columnName] === null || numberFromValue(row[columnName]) !== null
  );
}

function classifyRenderMode(params: {
  input: QueryKiloDatasetInput;
  output: QueryKiloDatasetOutput;
  metricColumns: QueryKiloDatasetColumn[];
  groupColumns: QueryKiloDatasetColumn[];
}): KiloDatasetRenderMode {
  const { input, output, metricColumns, groupColumns } = params;
  if (output.mode === 'aggregate' && groupColumns.length === 0 && metricColumns.length > 0) {
    return 'metric-grid';
  }
  if (
    output.mode === 'aggregate' &&
    groupColumns.length === 1 &&
    metricColumns.length === 1 &&
    allRowsHaveNumericValue(output, metricColumns[0].name)
  ) {
    return 'bar-chart';
  }
  if (
    input.mode === 'timeseries' &&
    output.mode === 'timeseries' &&
    groupColumns.length <= 1 &&
    metricColumns.length === 1 &&
    allRowsHaveNumericValue(output, metricColumns[0].name)
  ) {
    return 'timeseries-chart';
  }
  return 'table';
}

export function resolveKiloDatasetToolView(toolPart: ToolPart): KiloDatasetToolView {
  if (!isKiloDatasetQueryTool(toolPart)) return { kind: 'fallback' };

  const { state } = toolPart;
  if (state.status === 'pending' || state.status === 'running') {
    return { kind: 'status', status: state.status };
  }
  if (state.status === 'error') {
    return { kind: 'status', status: 'error', error: state.error };
  }

  const inputResult = QueryKiloDatasetInputSchema.safeParse(inputForKiloDatasetQuery(toolPart));
  if (!inputResult.success) return { kind: 'fallback' };

  const parsedOutput = parseKiloDatasetOutput(state.output);
  if (parsedOutput === undefined) return { kind: 'fallback' };

  const outputResult = QueryKiloDatasetOutputSchema.safeParse(parsedOutput);
  if (!outputResult.success) return { kind: 'fallback' };

  const input = inputResult.data;
  const output = outputResult.data;
  if (input.dataset !== output.dataset || input.mode !== output.mode) return { kind: 'fallback' };

  const metricColumns = metricColumnsForInput(input, output);
  const groupColumns = groupColumnsForInput(input, output);
  return {
    kind: 'ready',
    input,
    output,
    renderMode: classifyRenderMode({ input, output, metricColumns, groupColumns }),
    metricColumns,
    groupColumns,
  };
}

function labelForValue(column: QueryKiloDatasetColumn, value: RowValue): string {
  const scalarLabel = getKiloDatasetScalarValueLabel(column.name, value);
  if (scalarLabel) return scalarLabel;
  return String(value);
}

function formatColumnValue(column: QueryKiloDatasetColumn, value: RowValue): string {
  const scalarLabel = getKiloDatasetScalarValueLabel(column.name, value);
  if (scalarLabel) return scalarLabel;
  if (column.type === 'timestamp') return formatIsoDateString_UsaDateOnlyFormat(String(value));
  const numeric = numberFromValue(value);
  if (numeric !== null) {
    const lowerName = column.name.toLowerCase();
    if (lowerName.includes('costmicrodollars')) return formatDollarsFromMicrodollars(numeric);
    if (lowerName.includes('costusd')) return formatDollars(numeric);
    if (column.type === 'integer') return formatLargeNumber(numeric);
    if (column.type === 'decimal')
      return numeric.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(value);
}

function MetricGrid({ view }: { view: Extract<KiloDatasetToolView, { kind: 'ready' }> }) {
  const row = view.output.rows[0];
  if (!row) return <p className="text-muted-foreground text-sm">No data for this query.</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {view.metricColumns.map(column => (
        <div key={column.name} className="rounded-lg border bg-background/50 p-3">
          <div className="text-muted-foreground text-xs">
            {getKiloDatasetColumnLabel(column.name, view.output.dataset)}
          </div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatColumnValue(column, row[column.name])}
          </div>
        </div>
      ))}
    </div>
  );
}

function BarChartView({ view }: { view: Extract<KiloDatasetToolView, { kind: 'ready' }> }) {
  const groupColumn = view.groupColumns[0];
  const metricColumn = view.metricColumns[0];
  if (!groupColumn || !metricColumn || view.output.rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }

  const data = view.output.rows.map((row, index) => ({
    label: labelForValue(groupColumn, row[groupColumn.name]),
    value: numberFromValue(row[metricColumn.name]) ?? 0,
    color: chartColors[index % chartColors.length],
  }));
  const longestLabel = data.reduce((max, item) => Math.max(max, item.label.length), 0);
  const yAxisWidth = Math.min(220, Math.max(96, longestLabel * 7 + 16));
  const chartHeight = Math.min(420, Math.max(180, data.length * 36 + 24));

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {getKiloDatasetColumnLabel(metricColumn.name, view.output.dataset)} by{' '}
        {getKiloDatasetColumnLabel(groupColumn.name, view.output.dataset)}
      </p>
      <div className="w-full" style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
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

function buildTimeseriesData(view: Extract<KiloDatasetToolView, { kind: 'ready' }>) {
  const metricColumn = view.metricColumns[0];
  const groupColumn = view.groupColumns[0];
  if (!metricColumn) return { data: [], seriesKeys: [] as string[] };

  if (!groupColumn) {
    return {
      data: view.output.rows.map(row => ({
        bucket: formatIsoDateString_UsaDateOnlyFormat(String(row.bucketStart ?? '')),
        [metricColumn.name]: numberFromValue(row[metricColumn.name]) ?? 0,
      })),
      seriesKeys: [metricColumn.name],
    };
  }

  const byBucket = new Map<string, Record<string, string | number>>();
  const seriesKeys: string[] = [];
  for (const row of view.output.rows) {
    const bucket = formatIsoDateString_UsaDateOnlyFormat(String(row.bucketStart ?? ''));
    const seriesKey = labelForValue(groupColumn, row[groupColumn.name]);
    if (!seriesKeys.includes(seriesKey)) seriesKeys.push(seriesKey);
    const existing = byBucket.get(bucket) ?? { bucket };
    existing[seriesKey] = numberFromValue(row[metricColumn.name]) ?? 0;
    byBucket.set(bucket, existing);
  }
  return { data: [...byBucket.values()], seriesKeys };
}

function TimeseriesChartView({ view }: { view: Extract<KiloDatasetToolView, { kind: 'ready' }> }) {
  const metricColumn = view.metricColumns[0];
  if (!metricColumn || view.output.rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }
  const { data, seriesKeys } = buildTimeseriesData(view);
  if (data.length === 0 || seriesKeys.length === 0) {
    return <p className="text-muted-foreground text-sm">No data for this query.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {getKiloDatasetColumnLabel(metricColumn.name, view.output.dataset)} over time
      </p>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="bucket" stroke="currentColor" fontSize={11} tickMargin={8} />
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
              formatter={value => [formatColumnValue(metricColumn, Number(value))]}
            />
            {seriesKeys.map((key, index) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                stroke={chartColors[index % chartColors.length]}
                fill={chartColors[index % chartColors.length]}
                fillOpacity={0.12}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TableView({ view }: { view: Extract<KiloDatasetToolView, { kind: 'ready' }> }) {
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
                {getKiloDatasetColumnLabel(column.name, view.output.dataset)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.output.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t">
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

function RenderedResult({ view }: { view: Extract<KiloDatasetToolView, { kind: 'ready' }> }) {
  if (view.renderMode === 'metric-grid') return <MetricGrid view={view} />;
  if (view.renderMode === 'bar-chart') return <BarChartView view={view} />;
  if (view.renderMode === 'timeseries-chart') return <TimeseriesChartView view={view} />;
  return <TableView view={view} />;
}

export function KiloDatasetToolCard({ toolPart }: { toolPart: ToolPart }) {
  const view = resolveKiloDatasetToolView(toolPart);
  if (view.kind === 'fallback') return <GenericToolCard toolPart={toolPart} />;

  if (view.kind === 'status') {
    return (
      <ToolCardShell icon={Database} title="Kilo usage" status={view.status}>
        {view.error ? (
          <pre className="overflow-auto rounded-md bg-background p-2 text-xs text-red-500">
            <code>{view.error}</code>
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {view.status === 'pending' ? 'Waiting...' : 'Running...'}
          </p>
        )}
      </ToolCardShell>
    );
  }

  return (
    <ToolCardShell
      icon={BarChart3}
      title={getKiloDatasetNameLabel(view.output.dataset)}
      status="completed"
      badge={
        <span className="text-muted-foreground shrink-0 text-xs">
          {getKiloDatasetRenderModeLabel(view.renderMode)}
        </span>
      }
      defaultExpanded
    >
      <div className="space-y-3">
        <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span>{getKiloDatasetNameLabel(view.output.dataset)}</span>
          <span>{getKiloDatasetModeLabel(view.output.mode)}</span>
          <span>
            {formatIsoDateString_UsaDateOnlyFormat(view.output.range.startDate)} to{' '}
            {formatIsoDateString_UsaDateOnlyFormat(view.output.range.endDate)}
          </span>
        </div>
        <RenderedResult view={view} />
      </div>
    </ToolCardShell>
  );
}
