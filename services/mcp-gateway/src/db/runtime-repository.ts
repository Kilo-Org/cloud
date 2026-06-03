import {
  GatewayAuthMode,
  GatewayInstanceStatus,
  GatewayOwnerScope,
  GatewayProviderGrantStatus,
  GatewayRouteStatus,
  type ScopedConnectRoute,
} from '@kilocode/mcp-gateway';
import { getWorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  mcp_gateway_assignments,
  mcp_gateway_config_secrets,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_audit_events,
  mcp_gateway_connection_instances,
  mcp_gateway_provider_grants,
} from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { MCPGatewayEnv } from '../types';

export function getRuntimeDb(env: MCPGatewayEnv['Bindings']) {
  return getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
}

export type ActiveRouteResolution = {
  route: typeof mcp_gateway_connect_resources.$inferSelect;
  config: typeof mcp_gateway_configs.$inferSelect;
};

export type RuntimeResolution = {
  route: typeof mcp_gateway_connect_resources.$inferSelect;
  config: typeof mcp_gateway_configs.$inferSelect;
  user: typeof kilocode_users.$inferSelect;
  membership: typeof organization_memberships.$inferSelect | null;
  assignment: typeof mcp_gateway_assignments.$inferSelect | null;
  instance: typeof mcp_gateway_connection_instances.$inferSelect;
  grant: typeof mcp_gateway_provider_grants.$inferSelect | null;
  staticSecret: typeof mcp_gateway_config_secrets.$inferSelect | null;
};

export async function resolveActiveRoute(params: {
  env: MCPGatewayEnv['Bindings'];
  route: ScopedConnectRoute;
}): Promise<ActiveRouteResolution | null> {
  const db = getRuntimeDb(params.env);
  const rows = await db
    .select({ route: mcp_gateway_connect_resources, config: mcp_gateway_configs })
    .from(mcp_gateway_connect_resources)
    .innerJoin(
      mcp_gateway_configs,
      eq(mcp_gateway_configs.config_id, mcp_gateway_connect_resources.config_id)
    )
    .where(
      and(
        eq(mcp_gateway_connect_resources.owner_scope, params.route.ownerScope),
        eq(mcp_gateway_connect_resources.owner_id, params.route.ownerId),
        eq(mcp_gateway_connect_resources.config_id, params.route.configId),
        eq(mcp_gateway_connect_resources.route_key, params.route.routeKey),
        eq(mcp_gateway_connect_resources.route_status, GatewayRouteStatus.Active),
        eq(mcp_gateway_configs.owner_scope, params.route.ownerScope),
        eq(mcp_gateway_configs.owner_id, params.route.ownerId),
        eq(mcp_gateway_configs.enabled, true),
        isNull(mcp_gateway_configs.deleted_at)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveRuntimeState(params: {
  env: MCPGatewayEnv['Bindings'];
  route: ScopedConnectRoute;
  userId: string;
}): Promise<RuntimeResolution | null> {
  const db = getRuntimeDb(params.env);
  const resolved = await resolveActiveRoute(params);
  if (!resolved) return null;

  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.id, params.userId),
        isNull(kilocode_users.blocked_reason),
        isNull(kilocode_users.blocked_at),
        eq(kilocode_users.is_bot, false)
      )
    )
    .limit(1);
  if (!user) return null;

  let membership: typeof organization_memberships.$inferSelect | null = null;
  let assignment: typeof mcp_gateway_assignments.$inferSelect | null = null;
  if (resolved.config.owner_scope === GatewayOwnerScope.Personal) {
    if (
      resolved.config.owner_id !== params.userId ||
      params.route.ownerScope !== GatewayOwnerScope.Personal
    )
      return null;
  } else {
    if (params.route.ownerScope !== GatewayOwnerScope.Organization) return null;
    const membershipRows = await db
      .select({ membership: organization_memberships })
      .from(organization_memberships)
      .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
      .where(
        and(
          eq(organization_memberships.organization_id, resolved.config.owner_id),
          eq(organization_memberships.kilo_user_id, params.userId),
          isNull(organizations.deleted_at)
        )
      )
      .limit(1);
    membership = membershipRows[0]?.membership ?? null;
    if (!membership) return null;
    const assignmentRows = await db
      .select()
      .from(mcp_gateway_assignments)
      .where(
        and(
          eq(mcp_gateway_assignments.config_id, resolved.config.config_id),
          eq(mcp_gateway_assignments.kilo_user_id, params.userId),
          isNull(mcp_gateway_assignments.revoked_at)
        )
      )
      .limit(1);
    assignment = assignmentRows[0] ?? null;
    if (!assignment) return null;
  }

  const instanceRows = await db
    .select()
    .from(mcp_gateway_connection_instances)
    .where(
      and(
        eq(mcp_gateway_connection_instances.owner_scope, resolved.config.owner_scope),
        eq(mcp_gateway_connection_instances.owner_id, resolved.config.owner_id),
        eq(mcp_gateway_connection_instances.config_id, resolved.config.config_id),
        eq(mcp_gateway_connection_instances.kilo_user_id, params.userId),
        eq(mcp_gateway_connection_instances.instance_status, GatewayInstanceStatus.Active)
      )
    )
    .limit(1);
  const instance = instanceRows[0];
  if (!instance) return null;

  const grantRows = await db
    .select()
    .from(mcp_gateway_provider_grants)
    .where(
      and(
        eq(mcp_gateway_provider_grants.instance_id, instance.instance_id),
        eq(mcp_gateway_provider_grants.grant_status, GatewayProviderGrantStatus.Active)
      )
    )
    .limit(1);
  const grant = grantRows[0] ?? null;
  if (
    (resolved.config.auth_mode === GatewayAuthMode.OAuthDynamic ||
      resolved.config.auth_mode === GatewayAuthMode.OAuthStatic) &&
    !grant
  ) {
    return null;
  }

  const staticSecretRows = await db
    .select()
    .from(mcp_gateway_config_secrets)
    .where(
      and(
        eq(mcp_gateway_config_secrets.config_id, resolved.config.config_id),
        eq(mcp_gateway_config_secrets.secret_kind, 'static_headers'),
        isNull(mcp_gateway_config_secrets.revoked_at)
      )
    )
    .limit(1);

  return {
    route: resolved.route,
    config: resolved.config,
    user,
    membership,
    assignment,
    instance,
    grant,
    staticSecret: staticSecretRows[0] ?? null,
  };
}

export async function recordRuntimeAudit(params: {
  env: MCPGatewayEnv['Bindings'];
  resolution: RuntimeResolution;
  outcome: 'success' | 'failure' | 'blocked';
  eventType: string;
  metadata?: Record<string, unknown>;
}) {
  const db = getRuntimeDb(params.env);
  await db.insert(mcp_gateway_audit_events).values({
    actor_kilo_user_id: params.resolution.user.id,
    owner_scope: params.resolution.config.owner_scope,
    owner_id: params.resolution.config.owner_id,
    config_id: params.resolution.config.config_id,
    connect_resource_id: params.resolution.route.connect_resource_id,
    instance_id: params.resolution.instance.instance_id,
    event_type: params.eventType,
    outcome: params.outcome,
    correlation_metadata: params.metadata ?? {},
  });
}

export async function findProviderSecret(params: {
  env: MCPGatewayEnv['Bindings'];
  configId: string;
  authMode: typeof GatewayAuthMode.OAuthDynamic | typeof GatewayAuthMode.OAuthStatic;
}) {
  const db = getRuntimeDb(params.env);
  const secretKind =
    params.authMode === GatewayAuthMode.OAuthDynamic
      ? 'dynamic_registration'
      : 'static_provider_credentials';
  const rows = await db
    .select()
    .from(mcp_gateway_config_secrets)
    .where(
      and(
        eq(mcp_gateway_config_secrets.config_id, params.configId),
        eq(mcp_gateway_config_secrets.secret_kind, secretKind),
        isNull(mcp_gateway_config_secrets.revoked_at)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
