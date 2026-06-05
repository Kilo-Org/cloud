import 'server-only';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  mcp_gateway_assignments,
  mcp_gateway_config_secrets,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_connection_instances,
  mcp_gateway_provider_grants,
} from '@kilocode/db/schema';
import type {
  GatewayAuthMode,
  GatewayExecutionContext,
  GatewayOwnerScope,
  GatewaySecretKind,
  GatewaySharingMode,
} from '@kilocode/mcp-gateway';
import {
  GatewayInstanceStatus,
  GatewayOwnerScope as GatewayOwnerScopeValue,
  GatewayProviderGrantStatus,
  GatewayRouteStatus,
  buildScopedConnectCanonicalUrl,
} from '@kilocode/mcp-gateway';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomToken } from './crypto';

export type GatewayDatabase = typeof db | DrizzleTransaction;

export type ResolvedGatewayRoute = {
  config: typeof mcp_gateway_configs.$inferSelect;
  route: typeof mcp_gateway_connect_resources.$inferSelect;
};

export type AuthorizedGatewaySubject = {
  user: typeof kilocode_users.$inferSelect;
  membership: typeof organization_memberships.$inferSelect | null;
  assignment: typeof mcp_gateway_assignments.$inferSelect | null;
  executionContext: GatewayExecutionContext;
};

export function createGatewayRepository(database: GatewayDatabase = db) {
  async function findActiveRouteByRoute(params: {
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId: string;
    routeKey: string;
  }): Promise<ResolvedGatewayRoute | null> {
    const rows = await database
      .select({ config: mcp_gateway_configs, route: mcp_gateway_connect_resources })
      .from(mcp_gateway_connect_resources)
      .innerJoin(
        mcp_gateway_configs,
        eq(mcp_gateway_configs.config_id, mcp_gateway_connect_resources.config_id)
      )
      .where(
        and(
          eq(mcp_gateway_connect_resources.owner_scope, params.ownerScope),
          eq(mcp_gateway_connect_resources.owner_id, params.ownerId),
          eq(mcp_gateway_connect_resources.config_id, params.configId),
          eq(mcp_gateway_connect_resources.route_key, params.routeKey),
          eq(mcp_gateway_connect_resources.route_status, GatewayRouteStatus.Active),
          eq(mcp_gateway_configs.enabled, true),
          isNull(mcp_gateway_configs.deleted_at)
        )
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async function findActiveRouteByConfigId(configId: string): Promise<ResolvedGatewayRoute | null> {
    const rows = await database
      .select({ config: mcp_gateway_configs, route: mcp_gateway_connect_resources })
      .from(mcp_gateway_connect_resources)
      .innerJoin(
        mcp_gateway_configs,
        eq(mcp_gateway_configs.config_id, mcp_gateway_connect_resources.config_id)
      )
      .where(
        and(
          eq(mcp_gateway_connect_resources.config_id, configId),
          eq(mcp_gateway_connect_resources.route_status, GatewayRouteStatus.Active),
          eq(mcp_gateway_configs.enabled, true),
          isNull(mcp_gateway_configs.deleted_at)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function findDashboardRouteByConfigId(
    configId: string
  ): Promise<ResolvedGatewayRoute | null> {
    const rows = await database
      .select({ config: mcp_gateway_configs, route: mcp_gateway_connect_resources })
      .from(mcp_gateway_connect_resources)
      .innerJoin(
        mcp_gateway_configs,
        eq(mcp_gateway_configs.config_id, mcp_gateway_connect_resources.config_id)
      )
      .where(
        and(
          eq(mcp_gateway_connect_resources.config_id, configId),
          eq(mcp_gateway_connect_resources.route_status, GatewayRouteStatus.Active),
          isNull(mcp_gateway_configs.deleted_at)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function findActiveRouteByCanonicalUrl(
    canonicalUrl: string
  ): Promise<ResolvedGatewayRoute | null> {
    const rows = await database
      .select({ config: mcp_gateway_configs, route: mcp_gateway_connect_resources })
      .from(mcp_gateway_connect_resources)
      .innerJoin(
        mcp_gateway_configs,
        eq(mcp_gateway_configs.config_id, mcp_gateway_connect_resources.config_id)
      )
      .where(
        and(
          eq(mcp_gateway_connect_resources.canonical_url, canonicalUrl),
          eq(mcp_gateway_connect_resources.route_status, GatewayRouteStatus.Active),
          eq(mcp_gateway_configs.enabled, true),
          isNull(mcp_gateway_configs.deleted_at)
        )
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async function findUser(userId: string) {
    const rows = await database
      .select()
      .from(kilocode_users)
      .where(
        and(
          eq(kilocode_users.id, userId),
          isNull(kilocode_users.blocked_reason),
          isNull(kilocode_users.blocked_at),
          eq(kilocode_users.is_bot, false)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function findMembership(userId: string, organizationId: string) {
    const rows = await database
      .select()
      .from(organization_memberships)
      .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
      .where(
        and(
          eq(organization_memberships.kilo_user_id, userId),
          eq(organization_memberships.organization_id, organizationId),
          isNull(organizations.deleted_at)
        )
      )
      .limit(1);
    return rows[0]?.organization_memberships ?? null;
  }

  async function findActiveAssignment(configId: string, userId: string) {
    const rows = await database
      .select()
      .from(mcp_gateway_assignments)
      .where(
        and(
          eq(mcp_gateway_assignments.config_id, configId),
          eq(mcp_gateway_assignments.kilo_user_id, userId),
          isNull(mcp_gateway_assignments.revoked_at)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function authorizeUserForRoute(params: {
    route: ResolvedGatewayRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
  }): Promise<AuthorizedGatewaySubject | null> {
    const user = await findUser(params.userId);
    if (!user) return null;

    if (params.route.config.owner_scope === GatewayOwnerScopeValue.Personal) {
      if (params.executionContext.type !== 'personal') return null;
      if (params.route.config.owner_id !== params.userId) return null;
      return {
        user,
        membership: null,
        assignment: null,
        executionContext: params.executionContext,
      };
    }

    if (params.executionContext.type !== 'organization') return null;
    if (params.executionContext.organizationId !== params.route.config.owner_id) return null;
    const membership = await findMembership(params.userId, params.route.config.owner_id);
    if (!membership) return null;
    const assignment = await findActiveAssignment(params.route.config.config_id, params.userId);
    if (!assignment) return null;
    return { user, membership, assignment, executionContext: params.executionContext };
  }

  async function findNonTerminalInstance(params: {
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId: string;
    userId: string;
  }) {
    const rows = await database
      .select()
      .from(mcp_gateway_connection_instances)
      .where(
        and(
          eq(mcp_gateway_connection_instances.owner_scope, params.ownerScope),
          eq(mcp_gateway_connection_instances.owner_id, params.ownerId),
          eq(mcp_gateway_connection_instances.config_id, params.configId),
          eq(mcp_gateway_connection_instances.kilo_user_id, params.userId),
          inArray(mcp_gateway_connection_instances.instance_status, [
            GatewayInstanceStatus.Active,
            GatewayInstanceStatus.NeedsReauth,
          ])
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function findActiveInstance(params: {
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId: string;
    userId: string;
  }) {
    const rows = await database
      .select()
      .from(mcp_gateway_connection_instances)
      .where(
        and(
          eq(mcp_gateway_connection_instances.owner_scope, params.ownerScope),
          eq(mcp_gateway_connection_instances.owner_id, params.ownerId),
          eq(mcp_gateway_connection_instances.config_id, params.configId),
          eq(mcp_gateway_connection_instances.kilo_user_id, params.userId),
          eq(mcp_gateway_connection_instances.instance_status, GatewayInstanceStatus.Active)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function ensureConnectionInstance(params: {
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId: string;
    userId: string;
  }) {
    const existing = await findNonTerminalInstance(params);
    if (existing) return existing;

    await database
      .insert(mcp_gateway_connection_instances)
      .values({
        owner_scope: params.ownerScope,
        owner_id: params.ownerId,
        config_id: params.configId,
        kilo_user_id: params.userId,
        instance_status: GatewayInstanceStatus.Active,
      })
      .onConflictDoNothing();

    const created = await findNonTerminalInstance(params);
    if (!created) {
      throw new Error('Failed to create gateway connection instance');
    }
    return created;
  }

  async function findActiveGrant(instanceId: string) {
    const rows = await database
      .select()
      .from(mcp_gateway_provider_grants)
      .where(
        and(
          eq(mcp_gateway_provider_grants.instance_id, instanceId),
          eq(mcp_gateway_provider_grants.grant_status, GatewayProviderGrantStatus.Active)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function findActiveSecret(configId: string, secretKind: GatewaySecretKind) {
    const rows = await database
      .select()
      .from(mcp_gateway_config_secrets)
      .where(
        and(
          eq(mcp_gateway_config_secrets.config_id, configId),
          eq(mcp_gateway_config_secrets.secret_kind, secretKind),
          isNull(mcp_gateway_config_secrets.revoked_at)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function createConfigWithRoute(params: {
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    name: string;
    remoteUrl: string;
    authMode: GatewayAuthMode;
    sharingMode: GatewaySharingMode;
    pathPassthrough: boolean;
    createdByUserId: string;
    gatewayBaseUrl: string;
    discoveredProviderMetadata: Record<string, unknown> | null;
  }) {
    const [config] = await database
      .insert(mcp_gateway_configs)
      .values({
        owner_scope: params.ownerScope,
        owner_id: params.ownerId,
        name: params.name,
        remote_url: params.remoteUrl,
        auth_mode: params.authMode,
        sharing_mode: params.sharingMode,
        path_passthrough: params.pathPassthrough,
        discovered_provider_metadata: params.discoveredProviderMetadata,
        created_by_kilo_user_id: params.createdByUserId,
      })
      .returning();
    const routeKey = randomToken(32);
    const canonicalUrl = buildScopedConnectCanonicalUrl(params.gatewayBaseUrl, {
      ownerScope: params.ownerScope,
      ownerId: params.ownerId,
      configId: config.config_id,
      routeKey,
    });
    const [route] = await database
      .insert(mcp_gateway_connect_resources)
      .values({
        config_id: config.config_id,
        owner_scope: params.ownerScope,
        owner_id: params.ownerId,
        route_key: routeKey,
        canonical_url: canonicalUrl,
        route_status: GatewayRouteStatus.Active,
      })
      .returning();
    return { config, route };
  }

  return {
    database,
    findActiveRouteByRoute,
    findActiveRouteByConfigId,
    findDashboardRouteByConfigId,
    findActiveRouteByCanonicalUrl,
    findUser,
    findMembership,
    findActiveAssignment,
    authorizeUserForRoute,
    findNonTerminalInstance,
    findActiveInstance,
    ensureConnectionInstance,
    findActiveGrant,
    findActiveSecret,
    createConfigWithRoute,
  };
}

export type GatewayRepository = ReturnType<typeof createGatewayRepository>;
