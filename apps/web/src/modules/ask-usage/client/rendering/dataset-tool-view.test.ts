import type { ToolPart } from '@/components/cloud-agent-next/types';
import {
  ASK_USAGE_FLATTENED_TOOL_NAME,
  ASK_USAGE_MCP_SERVER_NAME,
  ASK_USAGE_MCP_TOOL_NAME,
} from '../../shared/tool-identity';
import { isAskUsageDatasetQueryTool, resolveAskUsageDatasetToolView } from './dataset-tool-view';

const aggregateInput = {
  dataset: 'microdollar_usage',
  mode: 'aggregate',
  metrics: [{ operation: 'sum', field: 'costUsd' }],
  limit: 20,
};

const aggregateOutput = {
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

function completedToolPart(params: {
  input?: unknown;
  structuredContent?: unknown;
  output?: string;
  tool?: string;
}): ToolPart {
  return {
    id: 'part_usage_dataset',
    sessionID: 'ses_test',
    messageID: 'msg_ca0395def0011t6S1qwxQbPSYB',
    type: 'tool',
    callID: 'call_usage_dataset',
    tool: params.tool ?? ASK_USAGE_FLATTENED_TOOL_NAME,
    state: {
      status: 'completed',
      input: (params.input ?? aggregateInput) as Record<string, unknown>,
      output: params.output ?? '',
      structuredContent: params.structuredContent,
      title: ASK_USAGE_MCP_TOOL_NAME,
      metadata: {},
      time: { start: 1, end: 2 },
    } as ToolPart['state'],
  };
}

function statusToolPart(status: 'pending' | 'running' | 'error'): ToolPart {
  return {
    id: `part_${status}`,
    sessionID: 'ses_test',
    messageID: 'msg_ca0395def0011t6S1qwxQbPSYB',
    type: 'tool',
    callID: `call_${status}`,
    tool: ASK_USAGE_FLATTENED_TOOL_NAME,
    state:
      status === 'error'
        ? { status, input: aggregateInput, error: 'Tool failed', time: { start: 1, end: 2 } }
        : { status, input: aggregateInput, time: { start: 1 } },
  } as ToolPart;
}

describe('resolveAskUsageDatasetToolView', () => {
  it('accepts exact flattened ToolParts with preserved structuredContent', () => {
    const view = resolveAskUsageDatasetToolView(
      completedToolPart({ structuredContent: aggregateOutput })
    );

    expect(view).toMatchObject({ kind: 'ready', renderMode: 'metric-grid' });
    expect(view.kind === 'ready' ? view.metricColumns.map(column => column.name) : []).toEqual([
      'sum_costUsd',
    ]);
  });

  it('accepts the exact MCP envelope identity', () => {
    const part = completedToolPart({
      tool: 'mcp',
      input: {
        server_name: ASK_USAGE_MCP_SERVER_NAME,
        tool_name: ASK_USAGE_MCP_TOOL_NAME,
        arguments: aggregateInput,
      },
      structuredContent: aggregateOutput,
    });

    expect(isAskUsageDatasetQueryTool(part)).toBe(true);
    expect(resolveAskUsageDatasetToolView(part)).toMatchObject({
      kind: 'ready',
      renderMode: 'metric-grid',
    });
  });

  it('rejects wrong MCP server and tool names', () => {
    expect(
      isAskUsageDatasetQueryTool(
        completedToolPart({
          tool: 'mcp',
          input: {
            server_name: 'other_server',
            tool_name: ASK_USAGE_MCP_TOOL_NAME,
            arguments: aggregateInput,
          },
        })
      )
    ).toBe(false);

    expect(
      isAskUsageDatasetQueryTool(
        completedToolPart({
          tool: 'mcp',
          input: {
            server_name: ASK_USAGE_MCP_SERVER_NAME,
            tool_name: 'describe_kilo_dataset',
            arguments: aggregateInput,
          },
        })
      )
    ).toBe(false);
  });

  it('represents pending, running, and error states', () => {
    expect(resolveAskUsageDatasetToolView(statusToolPart('pending'))).toEqual({ kind: 'pending' });
    expect(resolveAskUsageDatasetToolView(statusToolPart('running'))).toEqual({ kind: 'running' });
    expect(resolveAskUsageDatasetToolView(statusToolPart('error'))).toEqual({
      kind: 'error',
      message: 'Tool failed',
    });
  });

  it('accepts validated direct JSON output when structured content was not preserved', () => {
    expect(
      resolveAskUsageDatasetToolView(completedToolPart({ output: JSON.stringify(aggregateOutput) }))
    ).toMatchObject({ kind: 'ready', renderMode: 'metric-grid' });
  });

  it('does not trust MCP text-content envelopes as dataset output', () => {
    expect(
      resolveAskUsageDatasetToolView(
        completedToolPart({
          output: JSON.stringify({
            structuredContent: aggregateOutput,
            content: [{ type: 'text', text: JSON.stringify(aggregateOutput) }],
          }),
        })
      )
    ).toEqual({ kind: 'unhandled' });
  });

  it('rejects mismatched dataset and mode', () => {
    expect(
      resolveAskUsageDatasetToolView(
        completedToolPart({ structuredContent: { ...aggregateOutput, dataset: 'code_reviews' } })
      )
    ).toEqual({ kind: 'unhandled' });

    expect(
      resolveAskUsageDatasetToolView(
        completedToolPart({ structuredContent: { ...aggregateOutput, mode: 'timeseries' } })
      )
    ).toEqual({ kind: 'unhandled' });
  });

  it('requires requested metric and group columns', () => {
    expect(
      resolveAskUsageDatasetToolView(
        completedToolPart({
          structuredContent: { ...aggregateOutput, columns: [], rows: [{}] },
        })
      )
    ).toEqual({ kind: 'unhandled' });

    expect(
      resolveAskUsageDatasetToolView(
        completedToolPart({
          input: { ...aggregateInput, groupBy: ['model'] },
          structuredContent: aggregateOutput,
        })
      )
    ).toEqual({ kind: 'unhandled' });
  });

  it('classifies grouped aggregate rows as a bar chart', () => {
    const view = resolveAskUsageDatasetToolView(
      completedToolPart({
        input: { ...aggregateInput, groupBy: ['model'] },
        structuredContent: {
          ...aggregateOutput,
          columns: [
            { name: 'model', type: 'string', nullable: true },
            { name: 'sum_costUsd', type: 'decimal', nullable: false },
          ],
          rows: [{ model: 'claude', sum_costUsd: '0' }],
        },
      })
    );

    expect(view).toMatchObject({ kind: 'ready', renderMode: 'bar-chart' });
  });

  it('classifies timeseries rows and preserves zero as data', () => {
    const view = resolveAskUsageDatasetToolView(
      completedToolPart({
        input: { ...aggregateInput, mode: 'timeseries', bucket: 'hour' },
        structuredContent: {
          ...aggregateOutput,
          mode: 'timeseries',
          columns: [
            { name: 'bucketStart', type: 'timestamp', nullable: false },
            { name: 'sum_costUsd', type: 'decimal', nullable: false },
          ],
          rows: [
            { bucketStart: '2026-06-23T00:00:00.000Z', sum_costUsd: 0 },
            { bucketStart: '2026-06-23T01:00:00.000Z', sum_costUsd: '1.25' },
          ],
        },
      })
    );

    expect(view).toMatchObject({ kind: 'ready', renderMode: 'timeseries-chart' });
    expect(view.kind === 'ready' ? view.output.rows[0].sum_costUsd : undefined).toBe(0);
  });

  it('treats empty rows as valid no-data output', () => {
    const view = resolveAskUsageDatasetToolView(
      completedToolPart({ structuredContent: { ...aggregateOutput, rows: [] } })
    );

    expect(view).toMatchObject({ kind: 'ready', renderMode: 'metric-grid' });
  });

  it('falls back to a table for valid complex shapes', () => {
    const view = resolveAskUsageDatasetToolView(
      completedToolPart({
        input: { ...aggregateInput, groupBy: ['model'], metrics: [{ operation: 'count' }] },
        structuredContent: {
          ...aggregateOutput,
          columns: [
            { name: 'model', type: 'string', nullable: true },
            { name: 'count', type: 'integer', nullable: false },
          ],
          rows: [{ model: 'claude', count: 'not numeric' }],
        },
      })
    );

    expect(view).toMatchObject({ kind: 'ready', renderMode: 'table' });
  });
});
