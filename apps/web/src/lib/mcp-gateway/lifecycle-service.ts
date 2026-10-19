import 'server-only';

import type { db, DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  mcp_gateway_assignments,
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
  mcp_gateway_configs,
  mcp_gateway_connection_instances,
  mcp_gateway_oauth_grants,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

type GatewayDatabase = typeof db | DrizzleTransaction;

async function deleteUserGrantState(
  database: GatewayDatabase,
  userId: string,
  configIds?: string[]
) {
  const configFilter = configIds
    ? {
        pending: inArray(mcp_gateway_pending_provider_authorizations.config_id, configIds),
        codes: inArray(mcp_gateway_authorization_codes.config_id, configIds),
        requests: inArray(mcp_gateway_authorization_requests.config_id, configIds),
        refreshTokens: inArray(mcp_gateway_refresh_tokens.config_id, configIds),
        grants: inArray(mcp_gateway_oauth_grants.config_id, configIds),
        instances: inArray(mcp_gateway_connection_instances.config_id, configIds),
        assignments: inArray(mcp_gateway_assignments.config_id, configIds),
      }
    : undefined;

  await database
    .delete(mcp_gateway_pending_provider_authorizations)
    .where(
      and(
        eq(mcp_gateway_pending_provider_authorizations.kilo_user_id, userId),
        configFilter?.pending
      )
    );
  await database
    .delete(mcp_gateway_authorization_codes)
    .where(and(eq(mcp_gateway_authorization_codes.kilo_user_id, userId), configFilter?.codes));
  await database
    .delete(mcp_gateway_authorization_requests)
    .where(
      and(eq(mcp_gateway_authorization_requests.kilo_user_id, userId), configFilter?.requests)
    );
  await database
    .delete(mcp_gateway_refresh_tokens)
    .where(and(eq(mcp_gateway_refresh_tokens.kilo_user_id, userId), configFilter?.refreshTokens));
  await database
    .delete(mcp_gateway_oauth_grants)
    .where(and(eq(mcp_gateway_oauth_grants.kilo_user_id, userId), configFilter?.grants));
  await database
    .delete(mcp_gateway_connection_instances)
    .where(and(eq(mcp_gateway_connection_instances.kilo_user_id, userId), configFilter?.instances));
  await database
    .delete(mcp_gateway_assignments)
    .where(and(eq(mcp_gateway_assignments.kilo_user_id, userId), configFilter?.assignments));
}

export async function revokeGatewayStateForUser(database: GatewayDatabase, userId: string) {
  await deleteUserGrantState(database, userId);
  await database
    .delete(mcp_gateway_configs)
    .where(
      and(eq(mcp_gateway_configs.owner_scope, 'personal'), eq(mcp_gateway_configs.owner_id, userId))
    );
}

export async function revokeGatewayStateForOrganizationMember(
  database: GatewayDatabase,
  organizationId: string,
  userId: string
) {
  const orgConfigs = await database
    .select({ configId: mcp_gateway_configs.config_id })
    .from(mcp_gateway_configs)
    .where(
      and(
        eq(mcp_gateway_configs.owner_scope, 'organization'),
        eq(mcp_gateway_configs.owner_id, organizationId)
      )
    );
  const configIds = orgConfigs.map(config => config.configId);
  if (configIds.length === 0) return;

  await deleteUserGrantState(database, userId, configIds);
}
