import type { Context } from 'hono';
import type { MCPGatewayEnv } from '../types';

export function notImplementedResponse(c: Context<MCPGatewayEnv>) {
  return c.json({ status: 'not_implemented' }, 501);
}
