import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineTestUser } from '@/tests/helpers/user.helper';
import type * as kiloDatasetServerModule from './kilo-dataset-server';

type RegisteredTool = {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    annotations: Record<string, unknown>;
  };
  handler: (input: unknown) => Promise<unknown>;
};

const mockRegisteredTools: RegisteredTool[] = [];
const mockGetKiloUsageCost = jest.fn<(params: unknown) => Promise<unknown>>();
const mockQueryKiloDatasetStats = jest.fn<(params: unknown) => Promise<unknown>>();

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler']
    ) {
      mockRegisteredTools.push({ name, config, handler });
    }
  },
}));

jest.mock('@/lib/kilo-datasets/query', () => ({
  getKiloUsageCost: mockGetKiloUsageCost,
  queryKiloDatasetStats: mockQueryKiloDatasetStats,
  formatKiloDatasetQueryError: (error: unknown) =>
    error instanceof Error ? error.message : 'Unable to query Kilo dataset',
}));

let kiloDatasetServer: typeof kiloDatasetServerModule | undefined;

beforeEach(async () => {
  mockRegisteredTools.length = 0;
  mockGetKiloUsageCost.mockReset();
  mockQueryKiloDatasetStats.mockReset();
  kiloDatasetServer = await import('./kilo-dataset-server');
});

function createServer() {
  if (!kiloDatasetServer) throw new Error('Server module was not loaded');
  kiloDatasetServer.createKiloDatasetMcpServer({ user: defineTestUser({ id: 'admin-user' }) });
}

function tool(name: string): RegisteredTool {
  const registration = mockRegisteredTools.find(registeredTool => registeredTool.name === name);
  if (!registration) throw new Error(`Tool not registered: ${name}`);
  return registration;
}

describe('createKiloDatasetMcpServer', () => {
  test('registers cost, query, and describe tools with usage guidance', () => {
    createServer();

    const costTool = tool('get_kilo_usage_cost');
    expect(costTool.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(costTool.config.description).toContain('{"period":"yesterday","timezone":null}');
    expect(costTool.config.description).toContain('returns one total row');
    expect(costTool.config.description).toContain('custom ranges, trends, or breakdowns');
    expect(
      costTool.config.inputSchema.safeParse({
        period: 'yesterday',
        timezone: null,
      }).success
    ).toBe(true);

    const queryTool = tool('query_kilo_dataset');
    expect(queryTool.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(queryTool.config.description).toContain('Use aggregate without bucket');
    expect(queryTool.config.description).toContain('Prefer get_kilo_usage_cost');
    expect(queryTool.config.description).toContain('custom ranges, trends, or breakdowns');
    expect(queryTool.config.description).toContain('Use count with no field');
    expect(queryTool.config.description).toContain('costUsd or costMicrodollars');
    expect(
      queryTool.config.inputSchema.safeParse({
        dataset: 'microdollar_usage',
        mode: 'aggregate',
        metrics: [{ operation: 'count', field: 'model' }],
      }).success
    ).toBe(false);

    const describeTool = tool('describe_kilo_dataset');
    expect(describeTool.config.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(describeTool.config.description).toContain('allowed Kilo dataset query fields');
  });

  test('describe tool returns cost fields and examples as structured content and JSON text', async () => {
    createServer();

    const result = (await tool('describe_kilo_dataset').handler({
      dataset: 'microdollar_usage',
      includeExamples: true,
    })) as {
      structuredContent: {
        datasets: Array<{
          metricFields: string[];
          examples?: Array<{ title: string; input: unknown }>;
        }>;
        recipes?: Array<{ id: string }>;
      };
      content: Array<{ type: string; text: string }>;
    };

    expect(result.structuredContent.datasets).toHaveLength(1);
    expect(result.structuredContent.datasets[0].metricFields).toContain('costUsd');
    expect(result.structuredContent.datasets[0].metricFields).toContain('costMicrodollars');
    expect(result.structuredContent.datasets[0].examples?.map(example => example.title)).toContain(
      'Total usage cost for a day'
    );
    expect(result.structuredContent.recipes?.map(recipe => recipe.id)).toContain(
      'usage_cost_yesterday'
    );
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  test('cost tool delegates with the authenticated user', async () => {
    const output = {
      dataset: 'microdollar_usage',
      period: 'yesterday',
      timezone: 'Europe/Athens',
      range: {
        startDate: '2026-06-21T21:00:00.000Z',
        endDate: '2026-06-22T21:00:00.000Z',
        timeField: 'createdAt',
      },
      columns: [
        { name: 'costUsd', type: 'decimal', nullable: false },
        { name: 'costMicrodollars', type: 'integer', nullable: false },
      ],
      rows: [{ costUsd: '0.42', costMicrodollars: 420000 }],
      summary: { totalCostUsd: '0.42', totalCostMicrodollars: 420000, rowCount: 1 },
      query: { tool: 'query_kilo_dataset', input: {} },
    };
    mockGetKiloUsageCost.mockResolvedValue(output);
    createServer();

    const input = { period: 'yesterday', timezone: 'Europe/Athens' };
    const result = (await tool('get_kilo_usage_cost').handler(input)) as {
      structuredContent: unknown;
      content: Array<{ type: string; text: string }>;
    };

    expect(mockGetKiloUsageCost).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'admin-user' }),
      input,
    });
    expect(result.structuredContent).toEqual(output);
    expect(JSON.parse(result.content[0].text)).toEqual(output);
  });

  test('query tool delegates to dataset stats with the authenticated user', async () => {
    const output = {
      dataset: 'microdollar_usage',
      mode: 'aggregate',
      scope: { type: 'me' },
      range: {
        startDate: '2026-06-22T00:00:00.000Z',
        endDate: '2026-06-23T00:00:00.000Z',
        timeField: 'createdAt',
      },
      columns: [{ name: 'sum_costUsd', type: 'decimal', nullable: false }],
      rows: [{ sum_costUsd: '1.23' }],
    };
    mockQueryKiloDatasetStats.mockResolvedValue(output);
    createServer();

    const input = {
      dataset: 'microdollar_usage',
      mode: 'aggregate',
      metrics: [{ operation: 'sum', field: 'costUsd' }],
    };
    const result = (await tool('query_kilo_dataset').handler(input)) as {
      structuredContent: unknown;
      content: Array<{ type: string; text: string }>;
    };

    expect(mockQueryKiloDatasetStats).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'admin-user' }),
      input,
    });
    expect(result.structuredContent).toEqual(output);
    expect(JSON.parse(result.content[0].text)).toEqual(output);
  });

  test('query tool returns safe formatted errors', async () => {
    mockQueryKiloDatasetStats.mockRejectedValue(
      new Error('metric field is not allowed: microdollars; allowed metric fields are costUsd')
    );
    createServer();

    const result = (await tool('query_kilo_dataset').handler({
      dataset: 'microdollar_usage',
      mode: 'aggregate',
      metrics: [{ operation: 'sum', field: 'microdollars' }],
    })) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('allowed metric fields');
  });

  test('cost tool returns safe formatted errors', async () => {
    mockGetKiloUsageCost.mockRejectedValue(new Error('timezone must be a valid IANA timezone'));
    createServer();

    const result = (await tool('get_kilo_usage_cost').handler({
      period: 'yesterday',
      timezone: 'not-a-zone',
    })) as { isError: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('valid IANA timezone');
  });
});
