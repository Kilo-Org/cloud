import type { Context } from 'hono';
import type { MCPGatewayEnv } from '../types';
import {
  OrgConnectRouteParamsSchema,
  UserConnectRouteParamsSchema,
  type OrgConnectRouteParams,
  type UserConnectRouteParams,
} from '../schemas/routes.schema';
import { notImplementedResponse } from '../lib/responses';

export function handleProtectedResourceMetadata(c: Context<MCPGatewayEnv>) {
  return notImplementedResponse(c);
}

export function handleUserProtectedResourceMetadata(
  c: Context<MCPGatewayEnv>,
  params: UserConnectRouteParams
) {
  UserConnectRouteParamsSchema.parse(params);
  return notImplementedResponse(c);
}

export function handleOrgProtectedResourceMetadata(
  c: Context<MCPGatewayEnv>,
  params: OrgConnectRouteParams
) {
  OrgConnectRouteParamsSchema.parse(params);
  return notImplementedResponse(c);
}
