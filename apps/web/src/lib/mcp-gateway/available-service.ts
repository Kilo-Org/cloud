import 'server-only';
import {
  mcp_gateway_assignments,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_provider_grants,
  mcp_gateway_connection_instances,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { GatewayExecutionContext } from '@kilocode/mcp-gateway';
import type { GatewayRepository } from './repository';

type AvailableRow = {
  config: typeof mcp_gateway_configs.$inferSelect;
  route: typeof mcp_gateway_connect_resources.$inferSelect;
  grant: typeof mcp_gateway_provider_grants.$inferSelect | null;
};

function mapAvailableRows(rows: AvailableRow[]) {
  return rows.map(({ config, route, grant }) => ({
    configId: config.config_id,
    name: config.name,
    ownerScope: config.owner_scope,
    authMode: config.auth_mode,
    sharingMode: config.sharing_mode,
    canonicalUrl: route.canonical_url,
    registryMetadata: config.registry_metadata,
    hasProviderGrant: grant !== null,
  }));
}

export function createAvailableService(repository: GatewayRepository) {
  async function listAvailableConfigs(userId: string, executionContext: GatewayExecutionContext) {
    if (executionContext.type === 'personal') {
      const rows = await repository.database
        .select({
          config: mcp_gateway_configs,
          route: mcp_gateway_connect_resources,
          grant: mcp_gateway_provider_grants,
        })
        .from(mcp_gateway_configs)
        .innerJoin(
          mcp_gateway_connect_resources,
          eq(mcp_gateway_connect_resources.config_id, mcp_gateway_configs.config_id)
        )
        .leftJoin(
          mcp_gateway_connection_instances,
          and(
            eq(mcp_gateway_connection_instances.config_id, mcp_gateway_configs.config_id),
            eq(mcp_gateway_connection_instances.kilo_user_id, userId),
            eq(mcp_gateway_connection_instances.instance_status, 'active')
          )
        )
        .leftJoin(
          mcp_gateway_provider_grants,
          and(
            eq(
              mcp_gateway_provider_grants.instance_id,
              mcp_gateway_connection_instances.instance_id
            ),
            eq(mcp_gateway_provider_grants.grant_status, 'active')
          )
        )
        .where(
          and(
            eq(mcp_gateway_configs.owner_scope, 'personal'),
            eq(mcp_gateway_configs.owner_id, userId),
            eq(mcp_gateway_configs.enabled, true),
            isNull(mcp_gateway_configs.deleted_at),
            eq(mcp_gateway_connect_resources.route_status, 'active')
          )
        );
      return mapAvailableRows(rows);
    }

    const rows = await repository.database
      .select({
        config: mcp_gateway_configs,
        route: mcp_gateway_connect_resources,
        grant: mcp_gateway_provider_grants,
      })
      .from(mcp_gateway_configs)
      .innerJoin(
        mcp_gateway_connect_resources,
        eq(mcp_gateway_connect_resources.config_id, mcp_gateway_configs.config_id)
      )
      .innerJoin(
        mcp_gateway_assignments,
        and(
          eq(mcp_gateway_assignments.config_id, mcp_gateway_configs.config_id),
          eq(mcp_gateway_assignments.kilo_user_id, userId),
          isNull(mcp_gateway_assignments.revoked_at)
        )
      )
      .innerJoin(
        organization_memberships,
        and(
          eq(
            organization_memberships.organization_id,
            sql`case when ${mcp_gateway_configs.owner_scope} = 'organization' then ${mcp_gateway_configs.owner_id}::uuid else null end`
          ),
          eq(organization_memberships.kilo_user_id, userId)
        )
      )
      .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
      .leftJoin(
        mcp_gateway_connection_instances,
        and(
          eq(mcp_gateway_connection_instances.config_id, mcp_gateway_configs.config_id),
          eq(mcp_gateway_connection_instances.kilo_user_id, userId),
          eq(mcp_gateway_connection_instances.instance_status, 'active')
        )
      )
      .leftJoin(
        mcp_gateway_provider_grants,
        and(
          eq(mcp_gateway_provider_grants.instance_id, mcp_gateway_connection_instances.instance_id),
          eq(mcp_gateway_provider_grants.grant_status, 'active')
        )
      )
      .where(
        and(
          eq(mcp_gateway_configs.owner_scope, 'organization'),
          eq(mcp_gateway_configs.owner_id, executionContext.organizationId),
          isNotNull(mcp_gateway_assignments.assignment_id),
          isNull(organizations.deleted_at),
          eq(mcp_gateway_configs.enabled, true),
          isNull(mcp_gateway_configs.deleted_at),
          eq(mcp_gateway_connect_resources.route_status, 'active')
        )
      );
    return mapAvailableRows(rows);
  }

  return { listAvailableConfigs };
}

export type GatewayAvailableService = ReturnType<typeof createAvailableService>;
