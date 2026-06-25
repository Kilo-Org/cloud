import {
  KILO_DATASET_TOOL_NAME,
  isKiloDatasetQueryTool,
  resolveKiloDatasetToolView,
} from './KiloDatasetToolCard';
import {
  getKiloDatasetColumnLabel,
  getKiloDatasetFriendlyText,
  getKiloDatasetNameLabel,
  getKiloDatasetRenderModeLabel,
  getKiloDatasetScalarValueLabel,
} from './kilo-dataset-display';
import type { ToolPart } from './types';

const validInput = {
  dataset: 'microdollar_usage',
  mode: 'aggregate',
  metrics: [{ operation: 'sum', field: 'costUsd' }],
  limit: 20,
};

const validOutput = {
  dataset: 'microdollar_usage',
  mode: 'aggregate',
  scope: { type: 'me' },
  range: {
    startDate: '2026-05-24T00:00:00.000Z',
    endDate: '2026-06-23T00:00:00.000Z',
    timeField: 'createdAt',
  },
  columns: [{ name: 'sum_costUsd', type: 'decimal', nullable: false }],
  rows: [{ sum_costUsd: '12.3456' }],
};

function completedToolPart(
  input: unknown,
  output: string,
  tool = KILO_DATASET_TOOL_NAME
): ToolPart {
  return {
    id: 'part_usage_dataset',
    sessionID: 'ses_test',
    messageID: 'msg_ca0395def0011t6S1qwxQbPSYB',
    type: 'tool',
    callID: 'call_usage_dataset',
    tool,
    state: {
      status: 'completed',
      input: input as Record<string, unknown>,
      output,
      title: 'query_kilo_dataset',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

describe('KiloDatasetToolCard', () => {
  it('accepts a valid completed result and classifies the deterministic render mode', () => {
    const part = completedToolPart(validInput, JSON.stringify(validOutput));

    const view = resolveKiloDatasetToolView(part);
    expect(view).toMatchObject({ kind: 'ready', renderMode: 'metric-grid' });
    expect(view.kind === 'ready' ? view.metricColumns.map(column => column.name) : []).toEqual([
      'sum_costUsd',
    ]);
  });

  it('accepts an MCP-shaped query result envelope', () => {
    const part = completedToolPart(
      {
        server_name: 'kilo_usage',
        tool_name: 'query_kilo_dataset',
        arguments: validInput,
      },
      JSON.stringify({
        structuredContent: validOutput,
        content: [{ type: 'text', text: JSON.stringify(validOutput) }],
      }),
      'mcp'
    );

    expect(isKiloDatasetQueryTool(part)).toBe(true);

    const view = resolveKiloDatasetToolView(part);
    expect(view).toMatchObject({ kind: 'ready', renderMode: 'metric-grid' });
  });

  it('rejects malformed or mismatched output for the generic fallback path', () => {
    const malformed = completedToolPart(validInput, '{"dataset":"microdollar_usage"');
    expect(resolveKiloDatasetToolView(malformed)).toEqual({ kind: 'fallback' });

    const mismatched = completedToolPart(
      validInput,
      JSON.stringify({ ...validOutput, dataset: 'code_reviews' })
    );
    expect(resolveKiloDatasetToolView(mismatched)).toEqual({ kind: 'fallback' });
  });

  it('maps internal dataset fields to user-facing labels', () => {
    expect(getKiloDatasetNameLabel('microdollar_usage')).toBe('Model usage');
    expect(getKiloDatasetNameLabel('code_reviews')).toBe('Code Reviewer');
    expect(getKiloDatasetColumnLabel('sum_costUsd', 'microdollar_usage')).toBe('Cost');
    expect(getKiloDatasetColumnLabel('sum_totalCostUsd', 'code_reviews')).toBe('Cost');
    expect(getKiloDatasetColumnLabel('bucketStart', 'microdollar_usage')).toBe('Date');
    expect(getKiloDatasetColumnLabel('count', 'code_reviews')).toBe('Reviews');
    expect(getKiloDatasetRenderModeLabel('timeseries-chart')).toBe('Trend');
    expect(getKiloDatasetScalarValueLabel('hasError', false)).toBe('Successful');
    expect(getKiloDatasetFriendlyText('costUsd over time')).toBe('Cost over time');
  });
});
