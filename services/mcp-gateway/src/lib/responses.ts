import type { Context } from 'hono';
import type { UserConnectRouteParams, OrgConnectRouteParams } from '../schemas/routes.schema';
import type { MCPGatewayEnv } from '../types';

export function notImplementedResponse(
  c: Context<MCPGatewayEnv>,
  params?: UserConnectRouteParams | OrgConnectRouteParams
) {
  void params;
  return c.json({ status: 'not_implemented' }, 501);
}
