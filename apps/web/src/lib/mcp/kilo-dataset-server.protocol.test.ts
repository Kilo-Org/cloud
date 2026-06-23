import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defineTestUser } from '@/tests/helpers/user.helper';
import type * as kiloDatasetServerModule from './kilo-dataset-server';

const mockTimedUsageQuery = jest.fn<() => Promise<unknown>>();

jest.mock('@/lib/usage-query', () => ({
  timedUsageQuery: mockTimedUsageQuery,
}));

let createKiloDatasetMcpServer: typeof kiloDatasetServerModule.createKiloDatasetMcpServer;

type ProtocolSession = {
  client: Client;
  server: ReturnType<typeof kiloDatasetServerModule.createKiloDatasetMcpServer>;
};

beforeAll(async () => {
  ({ createKiloDatasetMcpServer } = await import('./kilo-dataset-server'));
});

beforeEach(() => {
  mockTimedUsageQuery.mockReset();
});

async function createProtocolSession(): Promise<ProtocolSession> {
  const server = createKiloDatasetMcpServer({
    user: defineTestUser({ id: 'admin-user', is_admin: true }),
  });
  const client = new Client({ name: 'kilo-dataset-protocol-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

async function closeProtocolSession(session: ProtocolSession): Promise<void> {
  await session.client.close();
  await session.server.close();
}

function firstTextContent(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('Expected tool content');
  }
  if (!Array.isArray(result.content)) throw new Error('Expected array content');
  const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected text content');
  }
  return first.text;
}

describe('kilo dataset MCP protocol', () => {
  test('advertises a strict-compatible usage cost schema', async () => {
    const session = await createProtocolSession();

    try {
      const response = await session.client.listTools();
      const costTool = response.tools.find(tool => tool.name === 'get_kilo_usage_cost');

      expect(costTool).toBeDefined();
      if (!costTool) throw new Error('get_kilo_usage_cost was not advertised');

      const schema = costTool.inputSchema;
      const properties = schema.properties ?? {};

      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(properties).sort()).toEqual(['period', 'timezone']);
      expect(schema.required).toEqual(['period', 'timezone']);
      expect(properties.period).toMatchObject({
        type: 'string',
        enum: ['today', 'yesterday', 'last_7_days', 'last_30_days'],
      });
      expect(properties.period).not.toMatchObject({ enum: expect.arrayContaining(['custom']) });
      expect(properties.timezone).toMatchObject({
        anyOf: expect.arrayContaining([
          expect.objectContaining({ type: 'string' }),
          expect.objectContaining({ type: 'null' }),
        ]),
      });
      expect(JSON.stringify(properties.timezone)).not.toContain('minLength');

      for (const removedProperty of ['startDate', 'endDate', 'groupBy', 'bucket', 'limit']) {
        expect(properties).not.toHaveProperty(removedProperty);
      }
    } finally {
      await closeProtocolSession(session);
    }
  });

  test('calls the cost handler once and returns structured plus JSON text content', async () => {
    mockTimedUsageQuery.mockResolvedValue({
      rows: [{ sum_costUsd: '0.42', sum_costMicrodollars: '420000' }],
    });
    const session = await createProtocolSession();

    try {
      const result = await session.client.callTool({
        name: 'get_kilo_usage_cost',
        arguments: { period: 'yesterday', timezone: null },
      });

      expect(mockTimedUsageQuery).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        dataset: 'microdollar_usage',
        period: 'yesterday',
        timezone: 'UTC',
        query: {
          tool: 'query_kilo_dataset',
          input: {
            dataset: 'microdollar_usage',
            mode: 'aggregate',
            metrics: [
              { operation: 'sum', field: 'costUsd' },
              { operation: 'sum', field: 'costMicrodollars' },
            ],
          },
        },
        rows: [{ costUsd: '0.42', costMicrodollars: 420000 }],
        summary: { totalCostUsd: '0.42', totalCostMicrodollars: 420000, rowCount: 1 },
      });

      expect(JSON.parse(firstTextContent(result))).toEqual(result.structuredContent);
    } finally {
      await closeProtocolSession(session);
    }
  });

  test('returns handler-level errors for invalid timezones', async () => {
    const session = await createProtocolSession();

    try {
      const result = await session.client.callTool({
        name: 'get_kilo_usage_cost',
        arguments: { period: 'yesterday', timezone: 'not-a-zone' },
      });

      expect(mockTimedUsageQuery).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(firstTextContent(result)).toContain('timezone must be a valid IANA timezone');
    } finally {
      await closeProtocolSession(session);
    }
  });
});
