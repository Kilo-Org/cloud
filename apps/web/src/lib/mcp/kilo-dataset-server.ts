import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '@kilocode/db/schema';
import {
  DescribeKiloDatasetInputSchema,
  GetKiloUsageCostInputSchema,
  QueryKiloDatasetInputSchema,
} from '@/lib/kilo-datasets/contracts';
import { describeKiloDataset } from '@/lib/kilo-datasets/catalog-description';
import {
  formatKiloDatasetQueryError,
  getKiloUsageCost,
  queryKiloDatasetStats,
} from '@/lib/kilo-datasets/query';

function summarizeDatasetQueryInput(input: unknown) {
  if (!input || typeof input !== 'object') return { inputType: typeof input };
  const record = input as Record<string, unknown>;
  const filters = Array.isArray(record.filters)
    ? record.filters.map(filter => {
        if (!filter || typeof filter !== 'object') return { filterType: typeof filter };
        const filterRecord = filter as Record<string, unknown>;
        return {
          field: filterRecord.field,
          operator: filterRecord.operator,
          valueKind: Array.isArray(filterRecord.value) ? 'array' : typeof filterRecord.value,
          valueCount: Array.isArray(filterRecord.value) ? filterRecord.value.length : undefined,
        };
      })
    : undefined;
  const metrics = Array.isArray(record.metrics)
    ? record.metrics.map(metric => {
        if (!metric || typeof metric !== 'object') return { metricType: typeof metric };
        const metricRecord = metric as Record<string, unknown>;
        return { operation: metricRecord.operation, field: metricRecord.field };
      })
    : undefined;
  return {
    dataset: record.dataset,
    mode: record.mode,
    range: record.range,
    bucket: record.bucket,
    groupBy: record.groupBy,
    metrics,
    filters,
    orderBy: record.orderBy,
    limit: record.limit,
  };
}

function toStructuredContent(output: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(output));
}

function jsonToolResult(output: object) {
  return {
    structuredContent: toStructuredContent(output),
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
  };
}

export function createKiloDatasetMcpServer(params: { user: User }) {
  const server = new McpServer({ name: 'kilo-dataset', version: '0.1.0' });

  server.registerTool(
    'get_kilo_usage_cost',
    {
      title: 'Get Kilo Usage Cost',
      description:
        'Get total Kilo model usage cost for a common calendar period. For "What are my costs for yesterday?" call once with {"period":"yesterday","timezone":null}. null uses UTC; otherwise provide an exact IANA timezone. This tool returns one total row. Use query_kilo_dataset for custom ranges, trends, or breakdowns.',
      inputSchema: GetKiloUsageCostInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      try {
        const output = await getKiloUsageCost({ user: params.user, input });
        console.info('[kilo-dataset-mcp] get_kilo_usage_cost completed', {
          period: output.period,
          range: output.range,
          rowCount: output.rows.length,
          totalCostMicrodollars: output.summary.totalCostMicrodollars,
        });
        return jsonToolResult(output);
      } catch (error) {
        console.warn('[kilo-dataset-mcp] get_kilo_usage_cost failed', {
          error: formatKiloDatasetQueryError(error, 'get_kilo_usage_cost'),
        });
        return {
          isError: true,
          content: [
            { type: 'text', text: formatKiloDatasetQueryError(error, 'get_kilo_usage_cost') },
          ],
        };
      }
    }
  );

  server.registerTool(
    'query_kilo_dataset',
    {
      title: 'Query Kilo Dataset',
      description:
        'Query aggregate or timeseries stats for your own Kilo usage, sessions, and Code Reviewer activity over a maximum 60-day range. Prefer get_kilo_usage_cost for common total usage cost; use this tool for custom ranges, trends, or breakdowns. Use aggregate without bucket. Use timeseries with bucket: hour, day, or week. Use count with no field. For raw usage cost queries, use costUsd or costMicrodollars. Call describe_kilo_dataset first when you need allowed fields, recipes, or examples.',
      inputSchema: QueryKiloDatasetInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      try {
        const output = await queryKiloDatasetStats({ user: params.user, input });
        console.info('[kilo-dataset-mcp] query_kilo_dataset completed', {
          input: summarizeDatasetQueryInput(input),
          range: output.range,
          columns: output.columns.map(column => column.name),
          rowCount: output.rows.length,
        });
        return jsonToolResult(output);
      } catch (error) {
        console.warn('[kilo-dataset-mcp] query_kilo_dataset failed', {
          input: summarizeDatasetQueryInput(input),
          error: formatKiloDatasetQueryError(error),
        });
        return {
          isError: true,
          content: [{ type: 'text', text: formatKiloDatasetQueryError(error) }],
        };
      }
    }
  );

  server.registerTool(
    'describe_kilo_dataset',
    {
      title: 'Describe Kilo Dataset',
      description:
        'Describe the allowed Kilo dataset query fields, mode rules, recipes, output aliases, and example payloads. Call this before query_kilo_dataset when you are unsure which dataset, metric field, group field, or bucket shape to use. Prefer get_kilo_usage_cost for simple total cost questions.',
      inputSchema: DescribeKiloDatasetInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      const output = describeKiloDataset(input);
      return jsonToolResult(output);
    }
  );

  return server;
}
