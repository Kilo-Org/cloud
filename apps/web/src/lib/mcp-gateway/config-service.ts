import 'server-only';
import {
  GatewayOwnerScope,
  GatewaySecretKind,
  parseStaticHeaders,
  GatewaySharingMode,
  buildScopedConnectRootPath,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import {
  mcp_gateway_assignments,
  mcp_gateway_config_secrets,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_connection_instances,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_provider_grants,
} from '@kilocode/db/schema';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { GatewayAuthMode } from '@kilocode/mcp-gateway';
import type { GatewayAppConfig } from './config';
import { createGatewayRepository, type GatewayRepository } from './repository';
import { configSecretAad, nowIso, randomToken } from './crypto';
import { validatePublicHttpsDestination } from './discovery-service';
import type { GatewayDiscoveryService } from './discovery-service';
import { createAuditService } from './audit-service';

const secretScheme = 'mcp-gateway-credential-rsa-aes-256-gcm';

export function createConfigService(params: {
  repository: GatewayRepository;
  config: GatewayAppConfig;
  discoveryService: GatewayDiscoveryService;
}) {
  async function discoverProviderMetadata(input: { remoteUrl: string; authMode: GatewayAuthMode }) {
    if (input.authMode !== 'oauth_dynamic' && input.authMode !== 'oauth_static') return null;
    const discovery = await params.discoveryService.discoverRemoteProvider(input.remoteUrl);
    const provider = discovery.providerCandidates[0];
    if (!provider) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Remote provider metadata could not be discovered',
        400
      );
    }
    if (input.authMode === 'oauth_dynamic' && !provider.registration_endpoint) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Remote provider does not support dynamic registration',
        400
      );
    }
    return provider;
  }

  async function createPersonalConfig(input: {
    userId: string;
    name: string;
    remoteUrl: string;
    authMode: GatewayAuthMode;
    pathPassthrough?: boolean;
  }) {
    await validatePublicHttpsDestination(input.remoteUrl);
    const discoveredProviderMetadata = await discoverProviderMetadata(input);
    return await params.repository.database.transaction(async tx => {
      const repository = createGatewayRepository(tx);
      const created = await repository.createConfigWithRoute({
        ownerScope: GatewayOwnerScope.Personal,
        ownerId: input.userId,
        name: input.name,
        remoteUrl: input.remoteUrl,
        authMode: input.authMode,
        sharingMode: GatewaySharingMode.SingleUser,
        pathPassthrough: input.pathPassthrough ?? false,
        discoveredProviderMetadata,
        createdByUserId: input.userId,
        gatewayBaseUrl: params.config.gatewayBaseUrl,
      });
      await createAuditService(repository).record({
        actorUserId: input.userId,
        ownerScope: created.config.owner_scope,
        ownerId: created.config.owner_id,
        configId: created.config.config_id,
        connectResourceId: created.route.connect_resource_id,
        eventType: 'config_created',
        outcome: 'success',
      });
      return created;
    });
  }

  async function createOrganizationConfig(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    remoteUrl: string;
    authMode: GatewayAuthMode;
    sharingMode: GatewaySharingMode;
    initialAssignedUserId?: string;
    pathPassthrough?: boolean;
  }) {
    await validatePublicHttpsDestination(input.remoteUrl);
    const discoveredProviderMetadata = await discoverProviderMetadata(input);
    if (input.sharingMode === GatewaySharingMode.SingleUser && !input.initialAssignedUserId) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Single-user org configs require an initial assigned user',
        400
      );
    }
    return await params.repository.database.transaction(async tx => {
      const repository = createGatewayRepository(tx);
      if (input.initialAssignedUserId) {
        const membership = await repository.findMembership(
          input.initialAssignedUserId,
          input.organizationId
        );
        if (!membership) {
          throw createGatewayError(
            GatewayErrorCode.InvalidRequest,
            'Initial assignee must be an organization member',
            400
          );
        }
      }
      const created = await repository.createConfigWithRoute({
        ownerScope: GatewayOwnerScope.Organization,
        ownerId: input.organizationId,
        name: input.name,
        remoteUrl: input.remoteUrl,
        authMode: input.authMode,
        sharingMode: input.sharingMode,
        pathPassthrough: input.pathPassthrough ?? false,
        discoveredProviderMetadata,
        createdByUserId: input.actorUserId,
        gatewayBaseUrl: params.config.gatewayBaseUrl,
      });
      if (input.initialAssignedUserId) {
        await tx.insert(mcp_gateway_assignments).values({
          config_id: created.config.config_id,
          kilo_user_id: input.initialAssignedUserId,
          assigned_by_kilo_user_id: input.actorUserId,
          single_user_slot:
            input.sharingMode === GatewaySharingMode.SingleUser ? 'single_user' : null,
        });
      }
      await createAuditService(repository).record({
        actorUserId: input.actorUserId,
        ownerScope: created.config.owner_scope,
        ownerId: created.config.owner_id,
        configId: created.config.config_id,
        connectResourceId: created.route.connect_resource_id,
        eventType: 'config_created',
        outcome: 'success',
      });
      return created;
    });
  }

  async function revokeConfigGrants(tx: GatewayRepository['database'], configId: string) {
    const activeInstances = await tx
      .select({ instance_id: mcp_gateway_connection_instances.instance_id })
      .from(mcp_gateway_connection_instances)
      .where(eq(mcp_gateway_connection_instances.config_id, configId));
    const instanceIds = activeInstances.map(instance => instance.instance_id);
    if (instanceIds.length > 0) {
      await tx
        .update(mcp_gateway_provider_grants)
        .set({
          grant_status: 'revoked',
          revoked_at: nowIso(),
          grant_version: sql`${mcp_gateway_provider_grants.grant_version} + 1`,
        })
        .where(
          and(
            inArray(mcp_gateway_provider_grants.instance_id, instanceIds),
            eq(mcp_gateway_provider_grants.grant_status, 'active')
          )
        );
    }
    await tx
      .update(mcp_gateway_pending_provider_authorizations)
      .set({ pending_status: 'error', consumed_at: nowIso() })
      .where(
        and(
          eq(mcp_gateway_pending_provider_authorizations.config_id, configId),
          eq(mcp_gateway_pending_provider_authorizations.pending_status, 'pending')
        )
      );
  }

  async function upsertSecret(input: {
    configId: string;
    kind: (typeof GatewaySecretKind)[keyof typeof GatewaySecretKind];
    value: Record<string, unknown>;
  }) {
    if (input.kind === GatewaySecretKind.StaticHeaders) {
      const headers = input.value.headers;
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        throw createGatewayError(
          GatewayErrorCode.InvalidRequest,
          'Static headers must be an object',
          400
        );
      }
      const stringHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== 'string') {
          throw createGatewayError(
            GatewayErrorCode.InvalidRequest,
            'Static header values must be strings',
            400
          );
        }
        stringHeaders[name] = value;
      }
      parseStaticHeaders(stringHeaders);
    }

    const encryptedSecret = encryptKeyedEnvelope(
      JSON.stringify({ kind: input.kind, value: input.value }),
      secretScheme,
      params.config.credentialKeyset.active,
      configSecretAad(input.configId, input.kind)
    );
    const materialChange = input.kind === GatewaySecretKind.StaticProviderCredentials;

    return await params.repository.database.transaction(async tx => {
      await tx
        .update(mcp_gateway_config_secrets)
        .set({ revoked_at: nowIso() })
        .where(
          and(
            eq(mcp_gateway_config_secrets.config_id, input.configId),
            eq(mcp_gateway_config_secrets.secret_kind, input.kind),
            isNull(mcp_gateway_config_secrets.revoked_at)
          )
        );
      const [secret] = await tx
        .insert(mcp_gateway_config_secrets)
        .values({
          config_id: input.configId,
          secret_kind: input.kind,
          encrypted_secret: encryptedSecret,
        })
        .returning();
      if (materialChange) {
        await revokeConfigGrants(tx, input.configId);
        await tx
          .update(mcp_gateway_configs)
          .set({ config_version: sql`${mcp_gateway_configs.config_version} + 1` })
          .where(eq(mcp_gateway_configs.config_id, input.configId));
      }
      const [config] = await tx
        .select()
        .from(mcp_gateway_configs)
        .where(eq(mcp_gateway_configs.config_id, input.configId))
        .limit(1);
      if (config) {
        await createAuditService(createGatewayRepository(tx)).record({
          ownerScope: config.owner_scope,
          ownerId: config.owner_id,
          configId: config.config_id,
          eventType: 'config_secret_updated',
          outcome: 'success',
          metadata: { kind: input.kind },
        });
      }
      return secret;
    });
  }

  async function rotateRoute(input: { configId: string }) {
    return await params.repository.database.transaction(async tx => {
      const rows = await tx
        .select()
        .from(mcp_gateway_connect_resources)
        .where(
          and(
            eq(mcp_gateway_connect_resources.config_id, input.configId),
            eq(mcp_gateway_connect_resources.route_status, 'active')
          )
        )
        .limit(1);
      const activeRoute = rows[0];
      if (!activeRoute) {
        throw createGatewayError(GatewayErrorCode.NotFound, 'Active route not found', 404);
      }
      await tx
        .update(mcp_gateway_connect_resources)
        .set({ route_status: 'rotated', rotated_at: nowIso() })
        .where(
          eq(mcp_gateway_connect_resources.connect_resource_id, activeRoute.connect_resource_id)
        );
      const routeKey = randomToken(32);
      const canonicalUrl = new URL(activeRoute.canonical_url);
      canonicalUrl.pathname = buildScopedConnectRootPath({
        ownerScope: activeRoute.owner_scope,
        ownerId: activeRoute.owner_id,
        configId: activeRoute.config_id,
        routeKey,
      });
      const [route] = await tx
        .insert(mcp_gateway_connect_resources)
        .values({
          config_id: activeRoute.config_id,
          owner_scope: activeRoute.owner_scope,
          owner_id: activeRoute.owner_id,
          route_key: routeKey,
          canonical_url: canonicalUrl.toString(),
          route_status: 'active',
          route_version: activeRoute.route_version + 1,
        })
        .returning();
      await tx
        .update(mcp_gateway_configs)
        .set({ config_version: sql`${mcp_gateway_configs.config_version} + 1` })
        .where(eq(mcp_gateway_configs.config_id, input.configId));
      await createAuditService(createGatewayRepository(tx)).record({
        ownerScope: activeRoute.owner_scope,
        ownerId: activeRoute.owner_id,
        configId: activeRoute.config_id,
        connectResourceId: route.connect_resource_id,
        eventType: 'route_rotated',
        outcome: 'success',
      });
      return route;
    });
  }

  async function removeAssignmentState(
    tx: GatewayRepository['database'],
    configId: string,
    userId: string
  ) {
    const [assignment] = await tx
      .update(mcp_gateway_assignments)
      .set({ revoked_at: nowIso() })
      .where(
        and(
          eq(mcp_gateway_assignments.config_id, configId),
          eq(mcp_gateway_assignments.kilo_user_id, userId),
          isNull(mcp_gateway_assignments.revoked_at)
        )
      )
      .returning();
    if (!assignment) return null;
    const instances = await tx
      .update(mcp_gateway_connection_instances)
      .set({
        instance_status: 'removed',
        removed_at: nowIso(),
        instance_version: sql`${mcp_gateway_connection_instances.instance_version} + 1`,
      })
      .where(
        and(
          eq(mcp_gateway_connection_instances.config_id, configId),
          eq(mcp_gateway_connection_instances.kilo_user_id, userId),
          inArray(mcp_gateway_connection_instances.instance_status, ['active', 'needs_reauth'])
        )
      )
      .returning({ instance_id: mcp_gateway_connection_instances.instance_id });
    const instanceIds = instances.map(instance => instance.instance_id);
    if (instanceIds.length > 0) {
      await tx
        .update(mcp_gateway_provider_grants)
        .set({
          grant_status: 'revoked',
          revoked_at: nowIso(),
          grant_version: sql`${mcp_gateway_provider_grants.grant_version} + 1`,
        })
        .where(
          and(
            inArray(mcp_gateway_provider_grants.instance_id, instanceIds),
            eq(mcp_gateway_provider_grants.grant_status, 'active')
          )
        );
    }
    return assignment;
  }

  async function revokeAssignment(input: { configId: string; userId: string }) {
    return await params.repository.database.transaction(async tx => {
      const assignment = await removeAssignmentState(tx, input.configId, input.userId);
      if (!assignment) return null;
      const [config] = await tx
        .select()
        .from(mcp_gateway_configs)
        .where(eq(mcp_gateway_configs.config_id, input.configId))
        .limit(1);
      if (config) {
        await createAuditService(createGatewayRepository(tx)).record({
          ownerScope: config.owner_scope,
          ownerId: config.owner_id,
          configId: config.config_id,
          actorUserId: assignment.assigned_by_kilo_user_id,
          eventType: 'assignment_removed',
          outcome: 'success',
        });
      }
      return assignment;
    });
  }

  async function assignUser(input: { configId: string; userId: string; actorUserId: string }) {
    return await params.repository.database.transaction(async tx => {
      const repository = createGatewayRepository(tx);
      const [config] = await tx
        .select()
        .from(mcp_gateway_configs)
        .where(
          and(
            eq(mcp_gateway_configs.config_id, input.configId),
            isNull(mcp_gateway_configs.deleted_at)
          )
        )
        .limit(1);
      if (!config || config.owner_scope !== GatewayOwnerScope.Organization) {
        throw createGatewayError(GatewayErrorCode.NotFound, 'Config not found', 404);
      }
      const membership = await repository.findMembership(input.userId, config.owner_id);
      if (!membership) {
        throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Assignee must be a member', 400);
      }
      if (config.sharing_mode === GatewaySharingMode.SingleUser) {
        const activeAssignments = await tx
          .select()
          .from(mcp_gateway_assignments)
          .where(
            and(
              eq(mcp_gateway_assignments.config_id, input.configId),
              isNull(mcp_gateway_assignments.revoked_at)
            )
          );
        for (const assignment of activeAssignments) {
          if (assignment.kilo_user_id !== input.userId) {
            await removeAssignmentState(tx, input.configId, assignment.kilo_user_id);
          }
        }
      }
      await tx
        .insert(mcp_gateway_assignments)
        .values({
          config_id: input.configId,
          kilo_user_id: input.userId,
          assigned_by_kilo_user_id: input.actorUserId,
          single_user_slot:
            config.sharing_mode === GatewaySharingMode.SingleUser ? 'single_user' : null,
        })
        .onConflictDoNothing();
      const assignment = await repository.findActiveAssignment(input.configId, input.userId);
      if (assignment) {
        await createAuditService(repository).record({
          actorUserId: input.actorUserId,
          ownerScope: config.owner_scope,
          ownerId: config.owner_id,
          configId: config.config_id,
          eventType: 'assignment_added',
          outcome: 'success',
        });
      }
      return assignment;
    });
  }

  async function disableConfig(configId: string) {
    const rows = await params.repository.database
      .update(mcp_gateway_configs)
      .set({ enabled: false, config_version: sql`${mcp_gateway_configs.config_version} + 1` })
      .where(eq(mcp_gateway_configs.config_id, configId))
      .returning();
    const config = rows[0] ?? null;
    if (config) {
      await createAuditService(params.repository).record({
        ownerScope: config.owner_scope,
        ownerId: config.owner_id,
        configId: config.config_id,
        eventType: 'config_disabled',
        outcome: 'success',
      });
    }
    return config;
  }

  async function deleteConfig(configId: string) {
    return await params.repository.database.transaction(async tx => {
      const [config] = await tx
        .update(mcp_gateway_configs)
        .set({
          enabled: false,
          deleted_at: nowIso(),
          config_version: sql`${mcp_gateway_configs.config_version} + 1`,
        })
        .where(
          and(eq(mcp_gateway_configs.config_id, configId), isNull(mcp_gateway_configs.deleted_at))
        )
        .returning();
      if (!config) return null;
      await tx
        .update(mcp_gateway_connect_resources)
        .set({ route_status: 'revoked', revoked_at: nowIso() })
        .where(
          and(
            eq(mcp_gateway_connect_resources.config_id, configId),
            eq(mcp_gateway_connect_resources.route_status, 'active')
          )
        );
      await revokeConfigGrants(tx, configId);
      await tx
        .update(mcp_gateway_connection_instances)
        .set({
          instance_status: 'removed',
          removed_at: nowIso(),
          instance_version: sql`${mcp_gateway_connection_instances.instance_version} + 1`,
        })
        .where(
          and(
            eq(mcp_gateway_connection_instances.config_id, configId),
            inArray(mcp_gateway_connection_instances.instance_status, ['active', 'needs_reauth'])
          )
        );
      await createAuditService(createGatewayRepository(tx)).record({
        ownerScope: config.owner_scope,
        ownerId: config.owner_id,
        configId: config.config_id,
        eventType: 'config_deleted',
        outcome: 'success',
      });
      return config;
    });
  }

  return {
    createPersonalConfig,
    createOrganizationConfig,
    upsertSecret,
    rotateRoute,
    revokeAssignment,
    assignUser,
    disableConfig,
    deleteConfig,
  };
}

export type GatewayConfigService = ReturnType<typeof createConfigService>;
