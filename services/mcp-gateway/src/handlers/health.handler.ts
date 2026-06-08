import type { Context } from 'hono';
import type { MCPGatewayEnv } from '../types';

export function handleHealth(c: Context<MCPGatewayEnv>) {
  return c.json({ status: 'ok', service: 'mcp-gateway' });
}
