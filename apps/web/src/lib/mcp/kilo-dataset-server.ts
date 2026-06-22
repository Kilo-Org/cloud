import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '@kilocode/db/schema';
import { QueryKiloDatasetInputSchema } from '@/lib/kilo-datasets/contracts';
import { queryKiloDatasetStats } from '@/lib/kilo-datasets/query';

export function createKiloDatasetMcpServer(params: { user: User }) {
  const server = new McpServer({ name: 'kilo-dataset', version: '0.1.0' });

  server.registerTool(
    'query_kilo_dataset',
    {
      title: 'Query Kilo Dataset',
      description:
        'Query aggregate or timeseries stats for your own Kilo usage, sessions, and Code Reviewer activity over a maximum 60-day range.',
      inputSchema: QueryKiloDatasetInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      const output = await queryKiloDatasetStats({ user: params.user, input });
      return {
        structuredContent: output,
        content: [{ type: 'text', text: JSON.stringify(output) }],
      };
    }
  );

  return server;
}
