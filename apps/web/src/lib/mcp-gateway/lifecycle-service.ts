import 'server-only';
import {
  mcp_gateway_assignments,
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
  mcp_gateway_config_secrets,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_connection_instances,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_provider_grants,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { GatewayDatabase } from './repository';
import { nowIso } from './crypto';

async function deleteInstanceSensitiveState(database: GatewayDatabase, instanceIds: string[]) {
  if (instanceIds.length === 0) return;
  await database
    .delete(mcp_gateway_provider_grants)
    .where(inArray(mcp_gateway_provider_grants.instance_id, instanceIds));
}

export async function revokeGatewayStateForUser(database: GatewayDatabase, userId: string) {
  const personalConfigs = await database
    .select({ configId: mcp_gateway_configs.config_id })
    .from(mcp_gateway_configs)
    .where(
      and(
        eq(mcp_gateway_configs.owner_scope, 'personal'),
        eq(mcp_gateway_configs.owner_id, userId),
        isNull(mcp_gateway_configs.deleted_at)
      )
    );
  const personalConfigIds = personalConfigs.map(config => config.configId);
  if (personalConfigIds.length > 0) {
    await database
      .delete(mcp_gateway_config_secrets)
      .where(inArray(mcp_gateway_config_secrets.config_id, personalConfigIds));
    await database
      .update(mcp_gateway_configs)
      .set({
        enabled: false,
        deleted_at: nowIso(),
        config_version: sql`${mcp_gateway_configs.config_version} + 1`,
      })
      .where(inArray(mcp_gateway_configs.config_id, personalConfigIds));
    await database
      .update(mcp_gateway_connect_resources)
      .set({ route_status: 'revoked', revoked_at: nowIso() })
      .where(
        and(
          inArray(mcp_gateway_connect_resources.config_id, personalConfigIds),
          eq(mcp_gateway_connect_resources.route_status, 'active')
        )
      );
  }

  await database
    .update(mcp_gateway_assignments)
    .set({ revoked_at: nowIso() })
    .where(
      and(
        eq(mcp_gateway_assignments.kilo_user_id, userId),
        isNull(mcp_gateway_assignments.revoked_at)
      )
    );

  const allInstanceRows = await database
    .select({ instanceId: mcp_gateway_connection_instances.instance_id })
    .from(mcp_gateway_connection_instances)
    .where(eq(mcp_gateway_connection_instances.kilo_user_id, userId));
  await database
    .update(mcp_gateway_connection_instances)
    .set({
      instance_status: 'removed',
      removed_at: nowIso(),
      instance_version: sql`${mcp_gateway_connection_instances.instance_version} + 1`,
    })
    .where(
      and(
        eq(mcp_gateway_connection_instances.kilo_user_id, userId),
        inArray(mcp_gateway_connection_instances.instance_status, ['active', 'needs_reauth'])
      )
    );
  await deleteInstanceSensitiveState(
    database,
    allInstanceRows.map(instance => instance.instanceId)
  );

  await database
    .delete(mcp_gateway_pending_provider_authorizations)
    .where(eq(mcp_gateway_pending_provider_authorizations.kilo_user_id, userId));
  await database
    .delete(mcp_gateway_authorization_codes)
    .where(eq(mcp_gateway_authorization_codes.kilo_user_id, userId));
  await database
    .delete(mcp_gateway_authorization_requests)
    .where(eq(mcp_gateway_authorization_requests.kilo_user_id, userId));
  await database
    .delete(mcp_gateway_refresh_tokens)
    .where(eq(mcp_gateway_refresh_tokens.kilo_user_id, userId));
}

export async function revokeGatewayStateForOrganizationMember(
  database: GatewayDatabase,
  organizationId: string,
  userId: string
) {
  const assignments = await database
    .select({ configId: mcp_gateway_assignments.config_id })
    .from(mcp_gateway_assignments)
    .innerJoin(
      mcp_gateway_configs,
      eq(mcp_gateway_configs.config_id, mcp_gateway_assignments.config_id)
    )
    .where(
      and(
        eq(mcp_gateway_assignments.kilo_user_id, userId),
        eq(mcp_gateway_configs.owner_scope, 'organization'),
        eq(mcp_gateway_configs.owner_id, organizationId),
        isNull(mcp_gateway_assignments.revoked_at)
      )
    );
  const configIds = assignments.map(assignment => assignment.configId);
  if (configIds.length === 0) return;
  await database
    .update(mcp_gateway_assignments)
    .set({ revoked_at: nowIso() })
    .where(
      and(
        inArray(mcp_gateway_assignments.config_id, configIds),
        eq(mcp_gateway_assignments.kilo_user_id, userId),
        isNull(mcp_gateway_assignments.revoked_at)
      )
    );
  const allInstanceRows = await database
    .select({ instanceId: mcp_gateway_connection_instances.instance_id })
    .from(mcp_gateway_connection_instances)
    .where(
      and(
        inArray(mcp_gateway_connection_instances.config_id, configIds),
        eq(mcp_gateway_connection_instances.kilo_user_id, userId)
      )
    );
  await database
    .update(mcp_gateway_connection_instances)
    .set({
      instance_status: 'removed',
      removed_at: nowIso(),
      instance_version: sql`${mcp_gateway_connection_instances.instance_version} + 1`,
    })
    .where(
      and(
        inArray(mcp_gateway_connection_instances.config_id, configIds),
        eq(mcp_gateway_connection_instances.kilo_user_id, userId),
        inArray(mcp_gateway_connection_instances.instance_status, ['active', 'needs_reauth'])
      )
    );
  await deleteInstanceSensitiveState(
    database,
    allInstanceRows.map(instance => instance.instanceId)
  );
  await database
    .delete(mcp_gateway_pending_provider_authorizations)
    .where(
      and(
        eq(mcp_gateway_pending_provider_authorizations.kilo_user_id, userId),
        inArray(mcp_gateway_pending_provider_authorizations.config_id, configIds)
      )
    );
  await database
    .delete(mcp_gateway_authorization_codes)
    .where(
      and(
        eq(mcp_gateway_authorization_codes.kilo_user_id, userId),
        inArray(mcp_gateway_authorization_codes.config_id, configIds)
      )
    );
  await database
    .delete(mcp_gateway_authorization_requests)
    .where(
      and(
        eq(mcp_gateway_authorization_requests.kilo_user_id, userId),
        inArray(mcp_gateway_authorization_requests.config_id, configIds)
      )
    );
  await database
    .delete(mcp_gateway_refresh_tokens)
    .where(
      and(
        eq(mcp_gateway_refresh_tokens.kilo_user_id, userId),
        inArray(mcp_gateway_refresh_tokens.config_id, configIds)
      )
    );
}
