import {
  QueryKiloDatasetInputSchema,
  QueryKiloDatasetOutputSchema,
  type QueryKiloDatasetColumn,
  type QueryKiloDatasetInput,
  type QueryKiloDatasetOutput,
} from '@/lib/kilo-datasets/contracts';
import type { ToolPart } from '@/components/cloud-agent-next/types';
import {
  ASK_USAGE_FLATTENED_TOOL_NAME,
  ASK_USAGE_MCP_SERVER_NAME,
  ASK_USAGE_MCP_TOOL_NAME,
} from '../../shared/tool-identity';

export type AskUsageDatasetRenderMode = 'metric-grid' | 'bar-chart' | 'timeseries-chart' | 'table';

export type AskUsageDatasetToolView =
  | { kind: 'unhandled' }
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      input: QueryKiloDatasetInput;
      output: QueryKiloDatasetOutput;
      renderMode: AskUsageDatasetRenderMode;
      metricColumns: QueryKiloDatasetColumn[];
      groupColumns: QueryKiloDatasetColumn[];
    };

type RowValue = QueryKiloDatasetOutput['rows'][number][string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function metricAlias(metric: QueryKiloDatasetInput['metrics'][number]): string {
  return metric.operation === 'count' ? 'count' : `${metric.operation}_${metric.field}`;
}

export function isAskUsageDatasetQueryTool(toolPart: ToolPart): boolean {
  if (toolPart.tool === ASK_USAGE_FLATTENED_TOOL_NAME) return true;
  if (toolPart.tool !== 'mcp') return false;

  const input = toolPart.state.input;
  return (
    input.server_name === ASK_USAGE_MCP_SERVER_NAME && input.tool_name === ASK_USAGE_MCP_TOOL_NAME
  );
}

function inputForAskUsageDatasetQuery(toolPart: ToolPart): unknown {
  if (toolPart.tool !== 'mcp') return toolPart.state.input;

  const input = toolPart.state.input;
  return isRecord(input) ? input.arguments : undefined;
}

function structuredContentForCompletedTool(toolPart: ToolPart): unknown {
  const { state } = toolPart;
  if (state.status !== 'completed') return undefined;
  const completedState = state as typeof state & { structuredContent?: unknown };
  if (completedState.structuredContent !== undefined) return completedState.structuredContent;
  if (typeof completedState.output !== 'string') return undefined;

  try {
    return JSON.parse(completedState.output);
  } catch {
    return undefined;
  }
}

function columnByName(output: QueryKiloDatasetOutput): Map<string, QueryKiloDatasetColumn> {
  return new Map(output.columns.map(column => [column.name, column]));
}

function metricColumnsForInput(
  input: QueryKiloDatasetInput,
  output: QueryKiloDatasetOutput
): QueryKiloDatasetColumn[] | null {
  const columns = columnByName(output);
  const metricColumns: QueryKiloDatasetColumn[] = [];
  for (const metric of input.metrics) {
    const column = columns.get(metricAlias(metric));
    if (!column) return null;
    metricColumns.push(column);
  }
  return metricColumns;
}

function groupColumnsForInput(
  input: QueryKiloDatasetInput,
  output: QueryKiloDatasetOutput
): QueryKiloDatasetColumn[] | null {
  const columns = columnByName(output);
  const groupColumns: QueryKiloDatasetColumn[] = [];
  for (const name of input.groupBy ?? []) {
    const column = columns.get(name);
    if (!column) return null;
    groupColumns.push(column);
  }
  return groupColumns;
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
}): AskUsageDatasetRenderMode {
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

export function resolveAskUsageDatasetToolView(toolPart: ToolPart): AskUsageDatasetToolView {
  if (!isAskUsageDatasetQueryTool(toolPart)) return { kind: 'unhandled' };

  const { state } = toolPart;
  if (state.status === 'pending') return { kind: 'pending' };
  if (state.status === 'running') return { kind: 'running' };
  if (state.status === 'error') return { kind: 'error', message: state.error };

  const inputResult = QueryKiloDatasetInputSchema.safeParse(inputForAskUsageDatasetQuery(toolPart));
  if (!inputResult.success) return { kind: 'unhandled' };

  const outputResult = QueryKiloDatasetOutputSchema.safeParse(
    structuredContentForCompletedTool(toolPart)
  );
  if (!outputResult.success) return { kind: 'unhandled' };

  const input = inputResult.data;
  const output = outputResult.data;
  if (input.dataset !== output.dataset || input.mode !== output.mode) return { kind: 'unhandled' };
  if (input.mode === 'timeseries' && !columnByName(output).has('bucketStart')) {
    return { kind: 'unhandled' };
  }

  const metricColumns = metricColumnsForInput(input, output);
  const groupColumns = groupColumnsForInput(input, output);
  if (!metricColumns || !groupColumns) return { kind: 'unhandled' };

  return {
    kind: 'ready',
    input,
    output,
    renderMode: classifyRenderMode({ input, output, metricColumns, groupColumns }),
    metricColumns,
    groupColumns,
  };
}
