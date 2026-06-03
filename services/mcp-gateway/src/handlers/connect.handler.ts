import type { Context } from 'hono';
import type { MCPGatewayEnv } from '../types';
import {
  OrgConnectRouteParamsSchema,
  UserConnectRouteParamsSchema,
  type OrgConnectRouteParams,
  type UserConnectRouteParams,
} from '../schemas/routes.schema';
import { notImplementedResponse } from '../lib/responses';

export function handleUserConnect(c: Context<MCPGatewayEnv>, params: UserConnectRouteParams) {
  UserConnectRouteParamsSchema.parse(params);
  return notImplementedResponse(c);
}

export function handleOrgConnect(c: Context<MCPGatewayEnv>, params: OrgConnectRouteParams) {
  OrgConnectRouteParamsSchema.parse(params);
  return notImplementedResponse(c);
}
