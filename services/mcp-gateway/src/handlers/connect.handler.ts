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
  const validatedParams = UserConnectRouteParamsSchema.parse(params);
  return notImplementedResponse(c, validatedParams);
}

export function handleOrgConnect(c: Context<MCPGatewayEnv>, params: OrgConnectRouteParams) {
  const validatedParams = OrgConnectRouteParamsSchema.parse(params);
  return notImplementedResponse(c, validatedParams);
}
