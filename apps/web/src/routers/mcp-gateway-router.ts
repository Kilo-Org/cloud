import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  mcp_gateway_assignments,
  mcp_gateway_config_secrets,
  mcp_gateway_configs,
  mcp_gateway_connect_resources,
  mcp_gateway_connection_instances,
  mcp_gateway_provider_grants,
} from '@kilocode/db/schema';
import {
  GatewayAuthMode,
  GatewayOwnerScope,
  GatewaySharingMode,
  GatewaySecretKind,
} from '@kilocode/mcp-gateway';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { db } from '@/lib/drizzle';
import { createGatewayRepository } from '@/lib/mcp-gateway/repository';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

const ConfigIdSchema = z.string().uuid();
const OrganizationIdSchema = z.string().uuid();
const RemoteUrlSchema = z.string().url();
const AuthModeSchema = z.enum([
  GatewayAuthMode.None,
  GatewayAuthMode.StaticHeaders,
  GatewayAuthMode.OAuthDynamic,
  GatewayAuthMode.OAuthStatic,
]);
const SharingModeSchema = z.enum([GatewaySharingMode.SingleUser, GatewaySharingMode.MultiUser]);
const StaticHeadersSchema = z.record(z.string(), z.string().min(1));
const ManagedConfigInputSchema = z.object({
  configId: ConfigIdSchema,
  organizationId: OrganizationIdSchema.optional(),
});
const mcpGatewayAdminProcedure = adminProcedure;

type ConfigRow = typeof mcp_gateway_configs.$inferSelect;
type RouteRow = typeof mcp_gateway_connect_resources.$inferSelect;
type AssignmentRow = typeof mcp_gateway_assignments.$inferSelect;
type InstanceRow = typeof mcp_gateway_connection_instances.$inferSelect;

function serializeTimestamp(value: string): string;
function serializeTimestamp(value: string | null): string | null;
function serializeTimestamp(value: string | null) {
  return value ? new Date(value).toISOString() : null;
}

function configProjection(params: {
  config: ConfigRow;
  route: RouteRow;
  assignments: AssignmentRow[];
  instances: InstanceRow[];
  activeGrantCount: number;
  secretKinds: string[];
}) {
  return {
    configId: params.config.config_id,
    name: params.config.name,
    ownerScope: params.config.owner_scope,
    ownerId: params.config.owner_id,
    remoteUrl: params.config.remote_url,
    authMode: params.config.auth_mode,
    sharingMode: params.config.sharing_mode,
    enabled: params.config.enabled,
    pathPassthrough: params.config.path_passthrough,
    configVersion: params.config.config_version,
    canonicalUrl: params.route.canonical_url,
    routeVersion: params.route.route_version,
    routeStatus: params.route.route_status,
    registryMetadata: params.config.registry_metadata,
    auxiliaryHeaders: params.config.auxiliary_headers,
    createdAt: serializeTimestamp(params.config.created_at),
    updatedAt: serializeTimestamp(params.config.updated_at),
    assignmentCount: params.assignments.length,
    instanceCount: params.instances.length,
    activeGrantCount: params.activeGrantCount,
    hasStaticHeaders: params.secretKinds.includes(GatewaySecretKind.StaticHeaders),
    hasStaticProviderCredentials: params.secretKinds.includes(
      GatewaySecretKind.StaticProviderCredentials
    ),
    hasDynamicRegistration: params.secretKinds.includes(GatewaySecretKind.DynamicRegistration),
  };
}

type ConfigProjection = ReturnType<typeof configProjection>;

function detailProjection(params: {
  projection: ConfigProjection;
  assignments: AssignmentRow[];
  instances: InstanceRow[];
}) {
  return {
    ...params.projection,
    assignments: params.assignments.map(assignment => ({
      assignmentId: assignment.assignment_id,
      userId: assignment.kilo_user_id,
      assignedByUserId: assignment.assigned_by_kilo_user_id,
      createdAt: serializeTimestamp(assignment.created_at),
    })),
    instances: params.instances.map(instance => ({
      instanceId: instance.instance_id,
      userId: instance.kilo_user_id,
      status: instance.instance_status,
      lastUsedAt: serializeTimestamp(instance.last_used_at),
    })),
  };
}

async function loadConfigRows(configIds: string[]) {
  const repository = createGatewayRepository(db);
  const assignments = configIds.length
    ? await repository.database
        .select()
        .from(mcp_gateway_assignments)
        .where(
          and(
            inArray(mcp_gateway_assignments.config_id, configIds),
            isNull(mcp_gateway_assignments.revoked_at)
          )
        )
    : [];
  const instances = configIds.length
    ? await repository.database
        .select()
        .from(mcp_gateway_connection_instances)
        .where(
          and(
            inArray(mcp_gateway_connection_instances.config_id, configIds),
            inArray(mcp_gateway_connection_instances.instance_status, ['active', 'needs_reauth'])
          )
        )
    : [];
  const instanceIds = instances.map(instance => instance.instance_id);
  const grants = instanceIds.length
    ? await repository.database
        .select()
        .from(mcp_gateway_provider_grants)
        .where(
          and(
            inArray(mcp_gateway_provider_grants.instance_id, instanceIds),
            eq(mcp_gateway_provider_grants.grant_status, 'active')
          )
        )
    : [];
  const secrets = configIds.length
    ? await repository.database
        .select({
          configId: mcp_gateway_config_secrets.config_id,
          kind: mcp_gateway_config_secrets.secret_kind,
        })
        .from(mcp_gateway_config_secrets)
        .where(
          and(
            inArray(mcp_gateway_config_secrets.config_id, configIds),
            isNull(mcp_gateway_config_secrets.revoked_at)
          )
        )
    : [];
  return { assignments, instances, grants, secrets };
}

async function listConfigs(params: {
  ownerScope: (typeof GatewayOwnerScope)[keyof typeof GatewayOwnerScope];
  ownerId: string;
}) {
  const repository = createGatewayRepository(db);
  const rows = await repository.database
    .select({ config: mcp_gateway_configs, route: mcp_gateway_connect_resources })
    .from(mcp_gateway_configs)
    .innerJoin(
      mcp_gateway_connect_resources,
      eq(mcp_gateway_connect_resources.config_id, mcp_gateway_configs.config_id)
    )
    .where(
      and(
        eq(mcp_gateway_configs.owner_scope, params.ownerScope),
        eq(mcp_gateway_configs.owner_id, params.ownerId),
        isNull(mcp_gateway_configs.deleted_at),
        eq(mcp_gateway_connect_resources.route_status, 'active')
      )
    )
    .orderBy(desc(mcp_gateway_configs.updated_at));
  const configIds = rows.map(row => row.config.config_id);
  const related = await loadConfigRows(configIds);
  return rows.map(({ config, route }) =>
    configProjection({
      config,
      route,
      assignments: related.assignments.filter(
        assignment => assignment.config_id === config.config_id
      ),
      instances: related.instances.filter(instance => instance.config_id === config.config_id),
      activeGrantCount: related.grants.filter(grant =>
        related.instances.some(
          instance =>
            instance.instance_id === grant.instance_id && instance.config_id === config.config_id
        )
      ).length,
      secretKinds: related.secrets
        .filter(secret => secret.configId === config.config_id)
        .map(secret => secret.kind),
    })
  );
}

async function getConfigDetail(params: {
  configId: string;
  ownerScope: (typeof GatewayOwnerScope)[keyof typeof GatewayOwnerScope];
  ownerId: string;
}) {
  const repository = createGatewayRepository(db);
  const resolved = await repository.findActiveRouteByConfigId(params.configId);
  if (
    !resolved ||
    resolved.config.owner_scope !== params.ownerScope ||
    resolved.config.owner_id !== params.ownerId
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
  }
  const related = await loadConfigRows([params.configId]);
  return detailProjection({
    projection: configProjection({
      config: resolved.config,
      route: resolved.route,
      assignments: related.assignments,
      instances: related.instances,
      activeGrantCount: related.grants.length,
      secretKinds: related.secrets.map(secret => secret.kind),
    }),
    assignments: related.assignments,
    instances: related.instances,
  });
}

async function requireManagedConfig(params: {
  configId: string;
  organizationId?: string;
  userId: string;
}) {
  const repository = createGatewayRepository(db);
  const resolved = await repository.findActiveRouteByConfigId(params.configId);
  if (!resolved) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
  const belongsToScope = params.organizationId
    ? resolved.config.owner_scope === GatewayOwnerScope.Organization &&
      resolved.config.owner_id === params.organizationId
    : resolved.config.owner_scope === GatewayOwnerScope.Personal &&
      resolved.config.owner_id === params.userId;
  if (!belongsToScope) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
  }
  return resolved;
}

export const mcpGatewayRouter = createTRPCRouter({
  discover: mcpGatewayAdminProcedure
    .input(z.object({ remoteUrl: RemoteUrlSchema }))
    .mutation(async ({ input }) => {
      const services = createGatewayServices();
      const discovery = await services.discoveryService.discoverRemoteProvider(input.remoteUrl);
      return {
        remoteUrl: discovery.remoteUrl,
        providerCandidates: discovery.providerCandidates.map(candidate => ({
          issuer: candidate.issuer,
          authorizationEndpoint: candidate.authorization_endpoint,
          tokenEndpoint: candidate.token_endpoint,
          hasRegistrationEndpoint: Boolean(candidate.registration_endpoint),
        })),
      };
    }),
  listPersonal: mcpGatewayAdminProcedure.query(async ({ ctx }) =>
    listConfigs({ ownerScope: GatewayOwnerScope.Personal, ownerId: ctx.user.id })
  ),
  listOrganization: mcpGatewayAdminProcedure
    .input(z.object({ organizationId: OrganizationIdSchema }))
    .query(async ({ input }) =>
      listConfigs({ ownerScope: GatewayOwnerScope.Organization, ownerId: input.organizationId })
    ),
  getPersonal: mcpGatewayAdminProcedure
    .input(z.object({ configId: ConfigIdSchema }))
    .query(async ({ input, ctx }) =>
      getConfigDetail({
        configId: input.configId,
        ownerScope: GatewayOwnerScope.Personal,
        ownerId: ctx.user.id,
      })
    ),
  getOrganization: mcpGatewayAdminProcedure
    .input(z.object({ organizationId: OrganizationIdSchema, configId: ConfigIdSchema }))
    .query(async ({ input }) =>
      getConfigDetail({
        configId: input.configId,
        ownerScope: GatewayOwnerScope.Organization,
        ownerId: input.organizationId,
      })
    ),
  createPersonal: mcpGatewayAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        remoteUrl: RemoteUrlSchema,
        authMode: AuthModeSchema,
        providerIssuer: z.string().url().optional(),
        staticProviderClientId: z.string().min(1).optional(),
        staticProviderClientSecret: z.string().min(1).optional(),
        pathPassthrough: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const services = createGatewayServices();
      const created = await services.configService.createPersonalConfig({
        userId: ctx.user.id,
        name: input.name,
        remoteUrl: input.remoteUrl,
        authMode: input.authMode,
        providerIssuer: input.providerIssuer,
        staticProviderClientId: input.staticProviderClientId,
        staticProviderClientSecret: input.staticProviderClientSecret,
        pathPassthrough: input.pathPassthrough,
      });
      return { configId: created.config.config_id };
    }),
  createOrganization: mcpGatewayAdminProcedure
    .input(
      z.object({
        organizationId: OrganizationIdSchema,
        name: z.string().min(1).max(200),
        remoteUrl: RemoteUrlSchema,
        authMode: AuthModeSchema,
        providerIssuer: z.string().url().optional(),
        staticProviderClientId: z.string().min(1).optional(),
        staticProviderClientSecret: z.string().min(1).optional(),
        sharingMode: SharingModeSchema,
        initialAssignedUserId: z.string().min(1).optional(),
        pathPassthrough: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const services = createGatewayServices();
      const created = await services.configService.createOrganizationConfig({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        name: input.name,
        remoteUrl: input.remoteUrl,
        authMode: input.authMode,
        providerIssuer: input.providerIssuer,
        staticProviderClientId: input.staticProviderClientId,
        staticProviderClientSecret: input.staticProviderClientSecret,
        sharingMode: input.sharingMode,
        initialAssignedUserId: input.initialAssignedUserId,
        pathPassthrough: input.pathPassthrough,
      });
      return { configId: created.config.config_id };
    }),
  startProviderSignIn: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      const resolved = await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      const services = createGatewayServices();
      const route = services.routeService.parseResource(resolved.route.canonical_url);
      const provider = await services.providerOAuthService.startDashboardProviderSignIn({
        resolved,
        route,
        userId: ctx.user.id,
        executionContext:
          resolved.config.owner_scope === GatewayOwnerScope.Organization
            ? { type: 'organization', organizationId: resolved.config.owner_id }
            : { type: 'personal' },
      });
      return { authorizationUrl: provider.authorizationUrl };
    }),
  rotateRoute: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      const services = createGatewayServices();
      const route = await services.configService.rotateRoute({ configId: input.configId });
      return { routeKey: route.route_key, canonicalUrl: route.canonical_url };
    }),
  disable: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      const services = createGatewayServices();
      const config = await services.configService.disableConfig(input.configId);
      if (!config) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      return { configId: config.config_id, enabled: config.enabled };
    }),
  delete: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      const services = createGatewayServices();
      const config = await services.configService.deleteConfig(input.configId);
      if (!config) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      return { configId: config.config_id };
    }),
  upsertStaticHeaders: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema.extend({ headers: StaticHeadersSchema }))
    .mutation(async ({ input, ctx }) => {
      const resolved = await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      if (resolved.config.auth_mode !== GatewayAuthMode.StaticHeaders) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Connection does not use static headers',
        });
      }
      const services = createGatewayServices();
      const secret = await services.configService.upsertSecret({
        configId: input.configId,
        kind: GatewaySecretKind.StaticHeaders,
        value: { headers: input.headers },
      });
      return { secretId: secret.config_secret_id };
    }),
  upsertStaticProviderCredentials: mcpGatewayAdminProcedure
    .input(
      ManagedConfigInputSchema.extend({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolved = await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      if (resolved.config.auth_mode !== GatewayAuthMode.OAuthStatic) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Connection does not use manual provider credentials',
        });
      }
      const services = createGatewayServices();
      const secret = await services.configService.upsertSecret({
        configId: input.configId,
        kind: GatewaySecretKind.StaticProviderCredentials,
        value: { clientId: input.clientId, clientSecret: input.clientSecret },
      });
      return { secretId: secret.config_secret_id };
    }),
  assignUser: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema.extend({ userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      const services = createGatewayServices();
      const assignment = await services.configService.assignUser({
        configId: input.configId,
        userId: input.userId,
        actorUserId: ctx.user.id,
      });
      if (!assignment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found' });
      return { assignmentId: assignment.assignment_id };
    }),
  revokeAssignment: mcpGatewayAdminProcedure
    .input(ManagedConfigInputSchema.extend({ userId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      await requireManagedConfig({
        configId: input.configId,
        organizationId: input.organizationId,
        userId: ctx.user.id,
      });
      const services = createGatewayServices();
      const assignment = await services.configService.revokeAssignment({
        configId: input.configId,
        userId: input.userId,
      });
      if (!assignment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assignment not found' });
      return { assignmentId: assignment.assignment_id };
    }),
});
