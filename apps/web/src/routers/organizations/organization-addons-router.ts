import {
  ORGANIZATION_ADDON_STATUSES,
  ORGANIZATION_MCP_CONNECT_DECISIONS,
  OrganizationAddonEnforcementSchema,
  type OrganizationAddonConfig,
  type OrganizationAddonSource,
  type OrganizationAddonType,
  type OrganizationMcpConnectDecision,
  type OrganizationMcpConnectTarget,
} from '@kilocode/db/schema-types';
import {
  kilocode_users,
  organization_addons,
  organization_mcp_connect_events,
  type OrganizationAddon,
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
} from '@/lib/organizations/addons/catalog';
import {
  mcpConfigFromTarget,
  mcpIdentityKey,
  mcpTargetFromConfig,
  normalizeMinVersion,
  normalizePackageIdentifier,
  normalizeRemoteMcpUrl,
  type McpTarget,
} from '@/lib/organizations/addons/mcp-identity';
import { requireGuardrailsOrganization } from '@/lib/organizations/require-guardrails-organization';

export const MAX_ORGANIZATION_ADDONS = 500;

const AddonStatusSchema = z.enum(ORGANIZATION_ADDON_STATUSES);
const McpCatalogSourceSchema = z.enum(['kilo_marketplace', 'mcp_registry']);

const AddonNameSchema = z.string().trim().min(1).max(120);
const AddonDescriptionSchema = z.string().trim().max(500);
const MinVersionInputSchema = z.string().max(64).nullable().optional();

const AddonIdInputSchema = OrganizationIdInputSchema.extend({ addonId: z.uuid() });

const AddFromRegistryInputSchema = OrganizationIdInputSchema.extend({
  type: z.literal('mcp'),
  source: McpCatalogSourceSchema,
  sourceId: z.string().min(1).max(300),
  identityKey: z.string().min(1).max(500),
  minVersion: MinVersionInputSchema,
});

const AddCustomInputSchema = OrganizationIdInputSchema.extend({
  type: z.literal('mcp'),
  source: z.literal('custom'),
  name: AddonNameSchema.optional(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('remote'), url: z.string().max(2048) }),
    z.object({
      kind: z.literal('package'),
      ecosystem: z.enum(['npm', 'pypi']),
      identifier: z.string().max(300),
    }),
  ]),
  minVersion: MinVersionInputSchema,
});

const AddInputSchema = z.discriminatedUnion('source', [
  AddFromRegistryInputSchema.extend({ source: z.literal('kilo_marketplace') }),
  AddFromRegistryInputSchema.extend({ source: z.literal('mcp_registry') }),
  AddCustomInputSchema,
]);

type Actor = { id: string; google_user_email: string; google_user_name: string };

function serializeAddon(row: OrganizationAddon) {
  return {
    id: row.id,
    type: row.type,
    identityKey: row.identity_key,
    name: row.name,
    description: row.description,
    status: row.status,
    config: row.config,
    source: row.source,
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

function minVersionForTarget(target: McpTarget, minVersion: string | null | undefined) {
  if (target.kind === 'remote') return null;
  const normalized = normalizeMinVersion(minVersion);
  if (!normalized.ok) badRequest(normalized.reason);
  return normalized.value;
}

function defaultCustomName(target: McpTarget): string {
  return target.kind === 'remote' ? new URL(target.url).host : target.identifier;
}

function approvedName(
  registryName: string | undefined,
  eventName: string | null,
  target: McpTarget
): string {
  const candidates = [registryName, eventName, defaultCustomName(target)];
  for (const candidate of candidates) {
    const name = candidate?.trim().slice(0, 120).trim();
    if (name) return name;
  }
  return defaultCustomName(target).slice(0, 120);
}

async function resolveAddInput(input: z.infer<typeof AddInputSchema>): Promise<{
  target: McpTarget;
  name: string;
  description: string | null;
  source: OrganizationAddonSource;
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
    name: item.name.slice(0, 120),
    description: item.description.trim().slice(0, 500) || null,
    source: { registry: input.source, id: item.sourceId },
  };
}

async function loadCatalogItem(source: McpCatalogSource, sourceId: string) {
  let item;
  try {
    item = await resolveMcpCatalogItem({ source, sourceId });
  } catch (error) {
    captureException(error, { tags: { source: 'organization-addons-catalog' } });
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

async function findAddon(organizationId: string, addonId: string): Promise<OrganizationAddon> {
  const [addon] = await db
    .select()
    .from(organization_addons)
    .where(
      and(
        eq(organization_addons.organization_id, organizationId),
        eq(organization_addons.id, addonId)
      )
    )
    .limit(1);
  if (!addon) throw new TRPCError({ code: 'NOT_FOUND', message: 'Add-on not found' });
  return addon;
}

function describeAddonType(type: OrganizationAddonType): string {
  return type === 'mcp' ? 'MCP server' : type;
}

function describeAddon(addon: Pick<OrganizationAddon, 'type' | 'name' | 'identity_key'>): string {
  return `${describeAddonType(addon.type)} ${addon.name} (${addon.identity_key})`;
}

function auditEntry(ctx: { user: Actor }, organizationId: string) {
  return {
    actor_email: ctx.user.google_user_email,
    actor_id: ctx.user.id,
    actor_name: ctx.user.google_user_name,
    organization_id: organizationId,
  };
}

function configWithMinVersion(
  config: OrganizationAddonConfig,
  minVersion: string | null
): OrganizationAddonConfig {
  return mcpConfigFromTarget(mcpTargetFromConfig(config), minVersion);
}

async function createAddon(params: {
  ctx: { user: Actor };
  organizationId: string;
  type: OrganizationAddonType;
  target: McpTarget;
  name: string;
  description: string | null;
  source: OrganizationAddonSource;
  minVersion: string | null;
  auditVerb: 'Added' | 'Approved';
}) {
  const identityKey = mcpIdentityKey(params.target);
  return await db.transaction(async tx => {
    const [{ total }] = await tx
      .select({ total: count() })
      .from(organization_addons)
      .where(eq(organization_addons.organization_id, params.organizationId));
    if (total >= MAX_ORGANIZATION_ADDONS) {
      badRequest(`An organization can have at most ${MAX_ORGANIZATION_ADDONS} add-ons.`);
    }
    const [created] = await tx
      .insert(organization_addons)
      .values({
        organization_id: params.organizationId,
        type: params.type,
        identity_key: identityKey,
        name: params.name,
        description: params.description,
        config: mcpConfigFromTarget(params.target, params.minVersion),
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
      action: 'organization.addon.add',
      ...auditEntry(params.ctx, params.organizationId),
      message: `${params.auditVerb} ${describeAddon(created)}`,
      tx,
    });
    return serializeAddon(created);
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

export const organizationAddonsRouter = createTRPCRouter({
  list: organizationAdminProcedure.query(async ({ input }) => {
    const organization = await requireGuardrailsOrganization(input.organizationId);
    const rows = await db
      .select()
      .from(organization_addons)
      .where(eq(organization_addons.organization_id, input.organizationId))
      .orderBy(asc(sql`lower(${organization_addons.name})`), asc(organization_addons.id));
    return {
      enforcement: {
        mcp: organization.settings.addon_guardrails?.mcp?.enforcement ?? ('off' as const),
        skill: {
          enabled: organization.settings.addon_guardrails?.skill?.enabled ?? false,
          scanBeforeUse: organization.settings.addon_guardrails?.skill?.scan_before_use ?? true,
        },
      },
      addons: rows.map(serializeAddon),
    };
  }),

  setEnforcement: organizationAdminMutationProcedure
    .input(
      z.discriminatedUnion('type', [
        OrganizationIdInputSchema.extend({
          type: z.literal('mcp'),
          enforcement: OrganizationAddonEnforcementSchema,
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
            addon_guardrails: {
              ...organization.settings.addon_guardrails,
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
        .select({ identityKey: organization_addons.identity_key })
        .from(organization_addons)
        .where(
          and(
            eq(organization_addons.organization_id, input.organizationId),
            eq(organization_addons.type, input.type)
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
        captureException(error, { tags: { source: 'organization-addons-catalog' } });
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
              ? { ...variant, alreadyAdded: addedKeys.has(variant.identityKey) }
              : variant
          ),
        })),
      };
    }),

  add: organizationAdminMutationProcedure.input(AddInputSchema).mutation(async ({ input, ctx }) => {
    await requireGuardrailsOrganization(input.organizationId);
    const resolved = await resolveAddInput(input);
    return await createAddon({
      ctx,
      organizationId: input.organizationId,
      type: input.type,
      target: resolved.target,
      name: resolved.name,
      description: resolved.description,
      source: resolved.source,
      minVersion: minVersionForTarget(resolved.target, input.minVersion),
      auditVerb: 'Added',
    });
  }),

  update: organizationAdminMutationProcedure
    .input(
      AddonIdInputSchema.extend({
        name: AddonNameSchema.optional(),
        description: AddonDescriptionSchema.nullable().optional(),
        minVersion: MinVersionInputSchema,
        target: AddCustomInputSchema.shape.target.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const addon = await findAddon(input.organizationId, input.addonId);
      let config = addon.config;
      let identityKey = addon.identity_key;
      let defaultName: string | null = null;
      if (input.target) {
        if (addon.source.registry !== 'custom') {
          badRequest('Only custom MCP servers can be changed.');
        }
        const target = targetFromCustomInput(input.target);
        config = mcpConfigFromTarget(target, minVersionForTarget(target, input.minVersion));
        identityKey = mcpIdentityKey(target);
        defaultName = defaultCustomName(target);
        if (identityKey !== addon.identity_key) {
          const [duplicate] = await db
            .select({ id: organization_addons.id })
            .from(organization_addons)
            .where(
              and(
                eq(organization_addons.organization_id, input.organizationId),
                eq(organization_addons.type, addon.type),
                eq(organization_addons.identity_key, identityKey)
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
      } else if (input.minVersion !== undefined) {
        if (addon.config.kind === 'remote')
          badRequest('Remote servers don’t have a minimum version.');
        const normalized = normalizeMinVersion(input.minVersion);
        if (!normalized.ok) badRequest(normalized.reason);
        config = configWithMinVersion(addon.config, normalized.value);
      }
      const [updated] = await db
        .update(organization_addons)
        .set({
          name: input.name ?? defaultName ?? addon.name,
          description:
            input.description === undefined ? addon.description : input.description || null,
          identity_key: identityKey,
          config,
        })
        .where(eq(organization_addons.id, addon.id))
        .returning();
      await createAuditLog({
        action: 'organization.addon.update',
        ...auditEntry(ctx, input.organizationId),
        message: `Updated ${describeAddon(updated)}`,
      });
      return serializeAddon(updated);
    }),

  setStatus: organizationAdminMutationProcedure
    .input(AddonIdInputSchema.extend({ status: AddonStatusSchema }))
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const addon = await findAddon(input.organizationId, input.addonId);
      if (addon.status === input.status) return serializeAddon(addon);
      const [updated] = await db
        .update(organization_addons)
        .set({ status: input.status })
        .where(eq(organization_addons.id, addon.id))
        .returning();
      await createAuditLog({
        action: 'organization.addon.update',
        ...auditEntry(ctx, input.organizationId),
        message: `${input.status === 'enabled' ? 'Enabled' : 'Disabled'} ${describeAddon(updated)}`,
      });
      return serializeAddon(updated);
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
              .select({ identityKey: organization_addons.identity_key })
              .from(organization_addons)
              .where(
                and(
                  eq(organization_addons.organization_id, input.organizationId),
                  eq(organization_addons.type, 'mcp'),
                  inArray(
                    organization_addons.identity_key,
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
      const addon = await createAddon({
        ctx,
        organizationId: input.organizationId,
        type: 'mcp',
        target,
        name: approvedName(match?.item.name, latest.serverName, target),
        description: match?.item.description.trim().slice(0, 500) || null,
        source: match
          ? { registry: match.item.source, id: match.item.sourceId }
          : { registry: 'custom', id: null },
        minVersion: null,
        auditVerb: 'Approved',
      });
      return { addon, matchedRegistry: match ? match.item.source : null };
    }),

  delete: organizationAdminMutationProcedure
    .input(AddonIdInputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const addon = await findAddon(input.organizationId, input.addonId);
      await db.transaction(async tx => {
        await tx.delete(organization_addons).where(eq(organization_addons.id, addon.id));
        await createAuditLog({
          action: 'organization.addon.remove',
          ...auditEntry(ctx, input.organizationId),
          message: `Removed ${describeAddon(addon)}`,
          tx,
        });
      });
      return { id: addon.id };
    }),
});
