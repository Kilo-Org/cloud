import {
  MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH,
  ORGANIZATION_GUARDRAIL_STATUSES,
  ORGANIZATION_MCP_CONNECT_DECISIONS,
  OrganizationGuardrailEnforcementSchema,
  type OrganizationGuardrailConfig,
  type OrganizationGuardrailSource,
  type OrganizationGuardrailType,
  type OrganizationMcpConnectDecision,
  type OrganizationMcpConnectTarget,
} from '@kilocode/db/schema-types';
import {
  kilocode_users,
  organization_guardrails,
  organization_mcp_connect_events,
  type OrganizationGuardrail,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { mutateOrganizationSettings } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationAdminMutationProcedure,
  organizationAdminProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  browseMcpCatalog,
  findMcpCatalogMatch,
  resolveMcpCatalogItem,
  type McpCatalogSource,
} from '@/lib/organizations/guardrails/catalog';
import {
  mcpConfigFromTarget,
  mcpIdentityKey,
  mcpTargetFromConfig,
  normalizePackageIdentifier,
  normalizeRemoteMcpUrl,
  type McpTarget,
} from '@/lib/organizations/guardrails/mcp-identity';
import {
  classifyLegacyMinVersion,
  isValidVersionSpec,
  MAX_SEMVER_LENGTH,
  minimumVersionForSpec,
  normalizeVersionSpec,
} from '@/lib/organizations/guardrails/version-spec';
import {
  MAX_MCP_IDENTITY_KEY_LENGTH,
  normalizeGuardrailConfig,
} from '@/lib/organizations/guardrails/guardrails-policy';
import { requireGuardrailsOrganization } from '@/lib/organizations/require-guardrails-organization';
import { isUniqueViolation } from '@/lib/db-errors';

export const MAX_ORGANIZATION_GUARDRAILS = 500;

const GuardrailStatusSchema = z.enum(ORGANIZATION_GUARDRAIL_STATUSES);
const McpCatalogSourceSchema = z.enum(['kilo_marketplace', 'mcp_registry']);

const GuardrailNameSchema = z.string().trim().min(1).max(MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH);
const GuardrailDescriptionSchema = z.string().trim().max(500);
const VersionSpecInputSchema = z.string().max(MAX_SEMVER_LENGTH).nullable().optional();

const GuardrailIdInputSchema = OrganizationIdInputSchema.extend({ guardrailId: z.uuid() });

const AddFromRegistryInputSchema = OrganizationIdInputSchema.extend({
  type: z.literal('mcp'),
  source: McpCatalogSourceSchema,
  sourceId: z.string().min(1).max(300),
  identityKey: z.string().min(1).max(500),
  versionSpec: VersionSpecInputSchema,
  /** Transitional alias for clients deployed before version ranges. */
  minVersion: VersionSpecInputSchema,
});

const AddCustomInputSchema = OrganizationIdInputSchema.extend({
  type: z.literal('mcp'),
  source: z.literal('custom'),
  name: GuardrailNameSchema.optional(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('remote'), url: z.string().max(2048) }),
    z.object({
      kind: z.literal('package'),
      ecosystem: z.enum(['npm', 'pypi']),
      identifier: z.string().max(300),
    }),
  ]),
  versionSpec: VersionSpecInputSchema,
  /** Transitional alias for clients deployed before version ranges. */
  minVersion: VersionSpecInputSchema,
});

const AddInputSchema = z.discriminatedUnion('source', [
  AddFromRegistryInputSchema.extend({ source: z.literal('kilo_marketplace') }),
  AddFromRegistryInputSchema.extend({ source: z.literal('mcp_registry') }),
  AddCustomInputSchema,
]);

type Actor = { id: string; google_user_email: string; google_user_name: string };

function serializeGuardrail(row: OrganizationGuardrail) {
  return {
    id: row.id,
    type: row.type,
    identityKey: row.identity_key,
    name: row.name,
    description: row.description,
    status: row.status,
    source: row.source,
    config: normalizeGuardrailConfig(row.config),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function badRequest(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

function targetFromCustomInput(input: z.infer<typeof AddCustomInputSchema>['target']): McpTarget {
  if (input.kind === 'remote') {
    const url = normalizeRemoteMcpUrl(input.url);
    if (!url.ok) badRequest(url.reason);
    return { kind: 'remote', url: url.value };
  }
  const identifier = normalizePackageIdentifier(input.ecosystem, input.identifier);
  if (!identifier.ok) badRequest(identifier.reason);
  return { kind: 'package', ecosystem: input.ecosystem, identifier: identifier.value };
}

type VersionSpecRequest = { versionSpec?: string | null; minVersion?: string | null };

type RequestedVersionSpec = {
  provided: boolean;
  value: string | null;
  /** The trimmed legacy `minVersion`, when the request used that alias. */
  legacyMinVersion: string | null;
};

function requestedVersionSpec(input: VersionSpecRequest): RequestedVersionSpec {
  if (input.versionSpec !== undefined) {
    const normalized = normalizeVersionSpec(input.versionSpec);
    if (!normalized.ok) badRequest(normalized.reason);
    return { provided: true, value: normalized.value, legacyMinVersion: null };
  }
  if (input.minVersion !== undefined) {
    const legacyMinVersion = input.minVersion?.trim() ?? '';
    if (legacyMinVersion === '') return { provided: true, value: null, legacyMinVersion };
    const legacy = classifyLegacyMinVersion(legacyMinVersion);
    if (legacy.kind === 'invalid') badRequest('Enter a version such as 1.2.3.');
    return {
      provided: true,
      value: legacy.kind === 'range' ? legacy.value : null,
      legacyMinVersion,
    };
  }
  return { provided: false, value: null, legacyMinVersion: null };
}

/**
 * A pre-range admin bundle resubmits the floor it was shown on every edit.
 * Resubmitting that unchanged floor keeps the stored range instead of
 * replacing it with a single minimum.
 */
function resubmitsCurrentFloor(
  request: RequestedVersionSpec,
  config: OrganizationGuardrailConfig
): boolean {
  return (
    config.kind === 'package' &&
    request.legacyMinVersion !== null &&
    request.legacyMinVersion !== '' &&
    request.legacyMinVersion === config.min_version
  );
}

function versionSpecForTarget(target: McpTarget, request: RequestedVersionSpec) {
  if (target.kind !== 'remote') return request.value;
  if (request.provided && request.value !== null)
    badRequest('Remote servers don’t have allowed versions.');
  return null;
}

/** Never truncated, because it is derived from the server's identity. */
function defaultCustomName(target: McpTarget): string {
  const name = target.kind === 'remote' ? new URL(target.url).host : target.identifier;
  if (name.length > MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH) {
    badRequest(
      `That server’s name is too long. Keep it under ${MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH} characters, or enter a name.`
    );
  }
  return name;
}

/** Display text from a registry or a client, which is safe to shorten. */
function clipDisplayName(name: string | null | undefined): string {
  return name?.trim().slice(0, MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH).trim() ?? '';
}

/** Connects with a longer identity key are always denied as unsupported, so don't allow one. */
function identityKeyForAllowList(target: McpTarget): string {
  const identityKey = mcpIdentityKey(target);
  if (identityKey.length > MAX_MCP_IDENTITY_KEY_LENGTH) {
    badRequest(
      `That server is too long to allow. Keep it under ${MAX_MCP_IDENTITY_KEY_LENGTH} characters.`
    );
  }
  return identityKey;
}

function approvedName(
  registryName: string | undefined,
  eventName: string | null,
  target: McpTarget
): string {
  return clipDisplayName(registryName) || clipDisplayName(eventName) || defaultCustomName(target);
}

async function resolveAddInput(input: z.infer<typeof AddInputSchema>): Promise<{
  target: McpTarget;
  name: string;
  description: string | null;
  source: OrganizationGuardrailSource;
}> {
  if (input.source === 'custom') {
    const target = targetFromCustomInput(input.target);
    return {
      target,
      name: input.name ?? defaultCustomName(target),
      description: null,
      source: { registry: 'custom', id: null },
    };
  }
  const item = await loadCatalogItem(input.source, input.sourceId);
  const variant = item.variants.find(
    candidate => candidate.eligible && candidate.identityKey === input.identityKey
  );
  if (!variant?.eligible) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'That option changed in the registry. Refresh the results and try again.',
    });
  }
  return {
    target: variant.target,
    name: clipDisplayName(item.name) || defaultCustomName(variant.target),
    description: item.description.trim().slice(0, 500) || null,
    source: { registry: input.source, id: item.sourceId },
  };
}

async function loadCatalogItem(source: McpCatalogSource, sourceId: string) {
  let item;
  try {
    item = await resolveMcpCatalogItem({ source, sourceId });
  } catch (error) {
    captureException(error, { tags: { source: 'organization-mcp-guardrails-catalog' } });
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'The registry couldn’t be reached. Try again.',
    });
  }
  if (!item) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'That server isn’t listed in the registry anymore.',
    });
  }
  return item;
}

async function findGuardrail(
  organizationId: string,
  guardrailId: string
): Promise<OrganizationGuardrail> {
  const [guardrail] = await db
    .select()
    .from(organization_guardrails)
    .where(
      and(
        eq(organization_guardrails.organization_id, organizationId),
        eq(organization_guardrails.id, guardrailId)
      )
    )
    .limit(1);
  if (!guardrail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardrail not found' });
  return guardrail;
}

function describeGuardrailType(type: OrganizationGuardrailType): string {
  return type === 'mcp' ? 'MCP server' : type;
}

function describeGuardrail(
  guardrail: Pick<OrganizationGuardrail, 'type' | 'name' | 'identity_key'>
): string {
  return `${describeGuardrailType(guardrail.type)} ${guardrail.name} (${guardrail.identity_key})`;
}

function auditEntry(ctx: { user: Actor }, organizationId: string) {
  return {
    actor_email: ctx.user.google_user_email,
    actor_id: ctx.user.id,
    actor_name: ctx.user.google_user_name,
    organization_id: organizationId,
  };
}

/** Stores the range together with the floor that pre-range clients still read. */
function configForTarget(
  target: McpTarget,
  versionSpec: string | null
): OrganizationGuardrailConfig {
  return mcpConfigFromTarget(target, versionSpec, minimumVersionForSpec(versionSpec));
}

async function createGuardrail(params: {
  ctx: { user: Actor };
  organizationId: string;
  type: OrganizationGuardrailType;
  target: McpTarget;
  name: string;
  description: string | null;
  source: OrganizationGuardrailSource;
  versionSpec: string | null;
  auditVerb: 'Added' | 'Approved';
}) {
  const identityKey = identityKeyForAllowList(params.target);
  return await db.transaction(async tx => {
    const [{ total }] = await tx
      .select({ total: count() })
      .from(organization_guardrails)
      .where(eq(organization_guardrails.organization_id, params.organizationId));
    if (total >= MAX_ORGANIZATION_GUARDRAILS) {
      badRequest(`An organization can have at most ${MAX_ORGANIZATION_GUARDRAILS} guardrails.`);
    }
    const [created] = await tx
      .insert(organization_guardrails)
      .values({
        organization_id: params.organizationId,
        type: params.type,
        identity_key: identityKey,
        name: params.name,
        description: params.description,
        config: configForTarget(params.target, params.versionSpec),
        source: params.source,
        created_by_kilo_user_id: params.ctx.user.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This MCP server is already on the allow list.',
      });
    }
    await createAuditLog({
      action: 'organization.guardrail.add',
      ...auditEntry(params.ctx, params.organizationId),
      message: `${params.auditVerb} ${describeGuardrail(created)}`,
      tx,
    });
    return serializeGuardrail(created);
  });
}

const CONNECTIONS_PAGE_SIZE = 50;
const CONNECTION_USERS_LIMIT = 200;

const ConnectionFilterShape = {
  decision: z.enum(ORGANIZATION_MCP_CONNECT_DECISIONS).optional(),
  client: z.string().min(1).max(50).optional(),
};

function connectionFilters(
  organizationId: string,
  filter: { decision?: OrganizationMcpConnectDecision; client?: string }
) {
  return and(
    eq(organization_mcp_connect_events.organization_id, organizationId),
    filter.decision ? eq(organization_mcp_connect_events.decision, filter.decision) : undefined,
    filter.client ? eq(organization_mcp_connect_events.client, filter.client) : undefined
  );
}

function toIsoString(value: string | Date): string {
  return new Date(value).toISOString();
}

export const organizationMcpGuardrailsRouter = createTRPCRouter({
  list: organizationAdminProcedure.query(async ({ input }) => {
    const organization = await requireGuardrailsOrganization(input.organizationId);
    const rows = await db
      .select()
      .from(organization_guardrails)
      .where(eq(organization_guardrails.organization_id, input.organizationId))
      .orderBy(asc(sql`lower(${organization_guardrails.name})`), asc(organization_guardrails.id));
    return {
      enforcement: {
        mcp: organization.settings.guardrails?.mcp?.enforcement ?? ('off' as const),
        skill: {
          enabled: organization.settings.guardrails?.skill?.enabled ?? false,
          scanBeforeUse: organization.settings.guardrails?.skill?.scan_before_use ?? true,
        },
      },
      guardrails: rows.map(serializeGuardrail),
    };
  }),

  setEnforcement: organizationAdminMutationProcedure
    .input(
      z.discriminatedUnion('type', [
        OrganizationIdInputSchema.extend({
          type: z.literal('mcp'),
          enforcement: OrganizationGuardrailEnforcementSchema,
        }),
        OrganizationIdInputSchema.extend({
          type: z.literal('skill'),
          enabled: z.boolean(),
          scanBeforeUse: z.boolean(),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      await db.transaction(async tx => {
        await mutateOrganizationSettings(
          input.organizationId,
          organization => ({
            ...organization.settings,
            guardrails: {
              ...organization.settings.guardrails,
              ...(input.type === 'mcp'
                ? { mcp: { enforcement: input.enforcement } }
                : { skill: { enabled: input.enabled, scan_before_use: input.scanBeforeUse } }),
            },
          }),
          tx
        );
        await createAuditLog({
          action: 'organization.settings.change',
          ...auditEntry(ctx, input.organizationId),
          message:
            input.type === 'mcp'
              ? `Set MCP server enforcement to ${input.enforcement}`
              : `Set skill guardrails to ${input.enabled ? 'enabled' : 'disabled'}, scan before use ${input.scanBeforeUse ? 'on' : 'off'}`,
          tx,
        });
      });
      return input.type === 'mcp'
        ? { type: input.type, enforcement: input.enforcement }
        : { type: input.type, enabled: input.enabled, scanBeforeUse: input.scanBeforeUse };
    }),

  browse: organizationAdminProcedure
    .input(
      z.object({
        type: z.literal('mcp'),
        source: McpCatalogSourceSchema,
        query: z.string().trim().max(100),
        cursor: z.string().max(500).nullish(),
      })
    )
    .query(async ({ input }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const existing = await db
        .select({ identityKey: organization_guardrails.identity_key })
        .from(organization_guardrails)
        .where(
          and(
            eq(organization_guardrails.organization_id, input.organizationId),
            eq(organization_guardrails.type, input.type)
          )
        );
      const addedKeys = new Set(existing.map(row => row.identityKey));
      let page;
      try {
        page = await browseMcpCatalog({
          source: input.source,
          query: input.query,
          cursor: input.cursor ?? null,
        });
      } catch (error) {
        captureException(error, { tags: { source: 'organization-mcp-guardrails-catalog' } });
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'The registry couldn’t be reached. Try again.',
        });
      }
      return {
        nextCursor: page.nextCursor,
        items: page.items.map(item => ({
          ...item,
          variants: item.variants.map(variant =>
            variant.eligible
              ? {
                  ...variant,
                  // Pre-range admin bundles prefill `versionHint` as a minimum version.
                  versionHint: minimumVersionForSpec(variant.versionSpecHint),
                  alreadyAdded: addedKeys.has(variant.identityKey),
                }
              : variant
          ),
        })),
      };
    }),

  add: organizationAdminMutationProcedure.input(AddInputSchema).mutation(async ({ input, ctx }) => {
    await requireGuardrailsOrganization(input.organizationId);
    const resolved = await resolveAddInput(input);
    const versionRequest = requestedVersionSpec(input);
    return await createGuardrail({
      ctx,
      organizationId: input.organizationId,
      type: input.type,
      target: resolved.target,
      name: resolved.name,
      description: resolved.description,
      source: resolved.source,
      versionSpec: versionSpecForTarget(resolved.target, versionRequest),
      auditVerb: 'Added',
    });
  }),

  update: organizationAdminMutationProcedure
    .input(
      GuardrailIdInputSchema.extend({
        name: GuardrailNameSchema.optional(),
        description: GuardrailDescriptionSchema.nullable().optional(),
        versionSpec: VersionSpecInputSchema,
        minVersion: VersionSpecInputSchema,
        target: AddCustomInputSchema.shape.target.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const guardrail = await findGuardrail(input.organizationId, input.guardrailId);
      const existingConfig = normalizeGuardrailConfig(guardrail.config);
      const versionRequest = requestedVersionSpec(input);
      let config: OrganizationGuardrailConfig | undefined;
      let identityKey = guardrail.identity_key;
      let defaultName: string | null = null;
      if (input.target) {
        if (guardrail.source.registry !== 'custom') {
          badRequest('Only custom MCP servers can be changed.');
        }
        const target = targetFromCustomInput(input.target);
        const keepVersionSpec =
          !versionRequest.provided || resubmitsCurrentFloor(versionRequest, existingConfig);
        const versionSpec = keepVersionSpec
          ? target.kind === 'package' && existingConfig.kind === 'package'
            ? existingConfig.version_spec
            : null
          : versionSpecForTarget(target, versionRequest);
        config =
          keepVersionSpec && versionSpec !== null && !isValidVersionSpec(versionSpec)
            ? mcpConfigFromTarget(
                target,
                guardrail.config.kind === 'package' ? guardrail.config.version_spec : null,
                guardrail.config.kind === 'package' ? (guardrail.config.min_version ?? null) : null
              )
            : configForTarget(target, versionSpec);
        identityKey = identityKeyForAllowList(target);
        defaultName = defaultCustomName(target);
        if (identityKey !== guardrail.identity_key) {
          const [duplicate] = await db
            .select({ id: organization_guardrails.id })
            .from(organization_guardrails)
            .where(
              and(
                eq(organization_guardrails.organization_id, input.organizationId),
                eq(organization_guardrails.type, guardrail.type),
                eq(organization_guardrails.identity_key, identityKey)
              )
            )
            .limit(1);
          if (duplicate) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This MCP server is already allowed.',
            });
          }
        }
      } else if (
        versionRequest.provided &&
        !resubmitsCurrentFloor(versionRequest, existingConfig)
      ) {
        if (existingConfig.kind === 'remote') {
          if (versionRequest.value !== null)
            badRequest('Remote servers don’t have allowed versions.');
        } else {
          config = configForTarget(mcpTargetFromConfig(existingConfig), versionRequest.value);
        }
      }
      let updated: OrganizationGuardrail;
      try {
        updated = await db.transaction(async tx => {
          const [row] = await tx
            .update(organization_guardrails)
            .set({
              name: input.name ?? defaultName ?? guardrail.name,
              description:
                input.description === undefined ? guardrail.description : input.description || null,
              identity_key: identityKey,
              config: config ?? guardrail.config,
            })
            .where(eq(organization_guardrails.id, guardrail.id))
            .returning();
          await createAuditLog({
            action: 'organization.guardrail.update',
            ...auditEntry(ctx, input.organizationId),
            message: `Updated ${describeGuardrail(row)}`,
            tx,
          });
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This MCP server is already allowed.',
          });
        }
        throw error;
      }
      return serializeGuardrail(updated);
    }),

  setStatus: organizationAdminMutationProcedure
    .input(GuardrailIdInputSchema.extend({ status: GuardrailStatusSchema }))
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const guardrail = await findGuardrail(input.organizationId, input.guardrailId);
      if (guardrail.status === input.status) return serializeGuardrail(guardrail);
      const [updated] = await db
        .update(organization_guardrails)
        .set({ status: input.status })
        .where(eq(organization_guardrails.id, guardrail.id))
        .returning();
      await createAuditLog({
        action: 'organization.guardrail.update',
        ...auditEntry(ctx, input.organizationId),
        message: `${input.status === 'enabled' ? 'Enabled' : 'Disabled'} ${describeGuardrail(updated)}`,
      });
      return serializeGuardrail(updated);
    }),

  listConnections: organizationAdminProcedure
    .input(z.object({ ...ConnectionFilterShape, cursor: z.number().int().min(0).default(0) }))
    .query(async ({ input }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const events = organization_mcp_connect_events;
      const lastSeen = sql`max(${events.created_at})`;
      const usersWith = (decision: OrganizationMcpConnectDecision) =>
        sql<number>`count(distinct ${events.kilo_user_id}) filter (where ${events.decision} = ${decision})`.mapWith(
          Number
        );
      const rows = await db
        .select({
          identityKey: events.identity_key,
          target: sql<OrganizationMcpConnectTarget>`(array_agg(${events.target} order by ${events.created_at} desc))[1]`,
          serverName: sql<
            string | null
          >`(array_agg(${events.server_name} order by ${events.created_at} desc))[1]`,
          clients: sql<string[]>`array_agg(distinct ${events.client})`,
          allowedUsers: usersWith('allowed'),
          deniedUsers: usersWith('denied'),
          lastSeenAt: sql<string | Date>`${lastSeen}`.mapWith(toIsoString),
        })
        .from(events)
        .where(connectionFilters(input.organizationId, input))
        .groupBy(events.identity_key)
        .orderBy(desc(lastSeen), asc(events.identity_key))
        .limit(CONNECTIONS_PAGE_SIZE + 1)
        .offset(input.cursor);

      const page = rows.slice(0, CONNECTIONS_PAGE_SIZE);
      const allowed =
        page.length === 0
          ? []
          : await db
              .select({ identityKey: organization_guardrails.identity_key })
              .from(organization_guardrails)
              .where(
                and(
                  eq(organization_guardrails.organization_id, input.organizationId),
                  eq(organization_guardrails.type, 'mcp'),
                  inArray(
                    organization_guardrails.identity_key,
                    page.map(row => row.identityKey)
                  )
                )
              );
      const allowedKeys = new Set(allowed.map(row => row.identityKey));
      return {
        connections: page.map(row => ({
          ...row,
          isOnAllowedList: allowedKeys.has(row.identityKey),
        })),
        nextCursor:
          rows.length > CONNECTIONS_PAGE_SIZE ? input.cursor + CONNECTIONS_PAGE_SIZE : null,
      };
    }),

  connectionUsers: organizationAdminProcedure
    .input(z.object({ ...ConnectionFilterShape, identityKey: z.string().min(1).max(500) }))
    .query(async ({ input }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const events = organization_mcp_connect_events;
      const lastSeen = sql`max(${events.created_at})`;
      const rows = await db
        .select({
          userId: events.kilo_user_id,
          name: kilocode_users.google_user_name,
          email: kilocode_users.google_user_email,
          client: events.client,
          decision: events.decision,
          connects: count(),
          lastSeenAt: sql<string | Date>`${lastSeen}`.mapWith(toIsoString),
        })
        .from(events)
        .leftJoin(kilocode_users, eq(kilocode_users.id, events.kilo_user_id))
        .where(
          and(
            connectionFilters(input.organizationId, input),
            eq(events.identity_key, input.identityKey)
          )
        )
        .groupBy(
          events.kilo_user_id,
          kilocode_users.google_user_name,
          kilocode_users.google_user_email,
          events.client,
          events.decision
        )
        .orderBy(desc(lastSeen), asc(events.kilo_user_id))
        .limit(CONNECTION_USERS_LIMIT);
      return { users: rows };
    }),

  approveConnection: organizationAdminMutationProcedure
    .input(z.object({ identityKey: z.string().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const [latest] = await db
        .select({
          target: organization_mcp_connect_events.target,
          serverName: organization_mcp_connect_events.server_name,
        })
        .from(organization_mcp_connect_events)
        .where(
          and(
            eq(organization_mcp_connect_events.organization_id, input.organizationId),
            eq(organization_mcp_connect_events.identity_key, input.identityKey)
          )
        )
        .orderBy(desc(organization_mcp_connect_events.created_at))
        .limit(1);
      if (!latest) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No connections found for this server.',
        });
      }

      const target = latest.target;
      const match = await findMcpCatalogMatch(target);
      const guardrail = await createGuardrail({
        ctx,
        organizationId: input.organizationId,
        type: 'mcp',
        target,
        name: approvedName(match?.item.name, latest.serverName, target),
        description: match?.item.description.trim().slice(0, 500) || null,
        source: match
          ? { registry: match.item.source, id: match.item.sourceId }
          : { registry: 'custom', id: null },
        versionSpec: null,
        auditVerb: 'Approved',
      });
      return { guardrail, matchedRegistry: match ? match.item.source : null };
    }),

  delete: organizationAdminMutationProcedure
    .input(GuardrailIdInputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const guardrail = await findGuardrail(input.organizationId, input.guardrailId);
      await db.transaction(async tx => {
        await tx
          .delete(organization_guardrails)
          .where(eq(organization_guardrails.id, guardrail.id));
        await createAuditLog({
          action: 'organization.guardrail.remove',
          ...auditEntry(ctx, input.organizationId),
          message: `Removed ${describeGuardrail(guardrail)}`,
          tx,
        });
      });
      return { id: guardrail.id };
    }),
});
