import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const mcpGatewayInstanceState = sqliteTable('mcp_gateway_instance_state', {
  instanceKey: text('instance_key').primaryKey(),
  grantVersion: integer('grant_version'),
  refreshStartedAt: text('refresh_started_at'),
  refreshFailedAt: text('refresh_failed_at'),
  updatedAt: text('updated_at').notNull(),
});

export const MCPGatewayInstanceStateRecord = z.object({
  instanceKey: z.string().min(1),
  grantVersion: z.number().int().nullable(),
  refreshStartedAt: z.string().nullable(),
  refreshFailedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export type MCPGatewayInstanceStateRecord = z.infer<typeof MCPGatewayInstanceStateRecord>;
