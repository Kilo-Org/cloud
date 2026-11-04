import {
  type OrganizationPermissionEventDecision,
  type OrganizationPermissionRuleSource,
} from '@kilocode/db/schema-types';
import {
  kilocode_users,
  organization_permission_events_daily,
  organization_permission_rules,
  type OrganizationPermissionRule,
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
import { TRPCError } from '@trpc/server';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import { resolvePermissionSettings } from '@/lib/organizations/guardrails/guardrails-policy';
import { MCP_CONNECT_CLIENTS } from '@/lib/organizations/guardrails/mcp-connections';
import { requireGuardrailsOrganization } from '@/lib/organizations/require-guardrails-organization';
import { evaluateOrgDecision } from '@/lib/organizations/permissions/evaluate';
import {
  MAX_COMMAND_KEY_LENGTH,
  MAX_ORGANIZATION_PERMISSION_RULES,
  MAX_PATTERN_LENGTH,
  MAX_PERMISSION_LENGTH,
  PERMISSION_EVENT_DECISIONS,
  PermissionActionSchema,
  PermissionEnforcementSchema,
  PermissionRuleInputSchema,
  comparePermissionRules,
  tierAction,
  type PermissionTier,
} from '@/lib/organizations/permissions/types';
import {
  validatePermissionRule,
  type PermissionRuleCandidate,
} from '@/lib/organizations/permissions/validate';
import { isUniqueViolation } from '@/lib/db-errors';

const EVENTS_PAGE_SIZE = 50;
const EVENT_USERS_LIMIT = 200;
const DUPLICATE_RULE_MESSAGE = 'This rule already exists.';

const RuleIdInputSchema = OrganizationIdInputSchema.extend({ ruleId: z.uuid() });
const PermissionSchema = z.string().trim().min(1).max(MAX_PERMISSION_LENGTH);
const CommandKeySchema = z.string().min(1).max(MAX_COMMAND_KEY_LENGTH);

const EventFilterShape = {
  decision: z.enum(PERMISSION_EVENT_DECISIONS).optional(),
  client: z.enum(MCP_CONNECT_CLIENTS).optional(),
  days: z.number().int().min(1).max(90).default(30),
};

type Actor = { id: string; google_user_email: string; google_user_name: string };

function serializeRule(row: OrganizationPermissionRule) {
  return {
    id: row.id,
    tier: row.tier,
    permission: row.permission,
    pattern: row.pattern,
    action: tierAction(row.tier),
    scope: { type: 'organization' as const },
    description: row.description,
    source: row.source,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function auditEntry(ctx: { user: Actor }, organizationId: string) {
  return {
    actor_email: ctx.user.google_user_email,
    actor_id: ctx.user.id,
    actor_name: ctx.user.google_user_name,
    organization_id: organizationId,
  };
}

function describeRule(rule: Pick<OrganizationPermissionRule, 'tier' | 'permission' | 'pattern'>) {
  return `${rule.tier} permission rule ${rule.permission} "${rule.pattern}"`;
}

function validateOrThrow(candidate: PermissionRuleCandidate): string[] {
  const { errors, warnings } = validatePermissionRule(candidate);
  if (errors.length > 0) throw new TRPCError({ code: 'BAD_REQUEST', message: errors.join(' ') });
  return warnings;
}

function conflict(): never {
  throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_RULE_MESSAGE });
}

function approvalPattern(commandKey: string): string {
  return commandKey === '*' ? '*' : `${commandKey} *`;
}

async function loadRules(organizationId: string) {
  return await db
    .select()
    .from(organization_permission_rules)
    .where(eq(organization_permission_rules.organization_id, organizationId));
}

async function findRule(organizationId: string, ruleId: string) {
  const [rule] = await db
    .select()
    .from(organization_permission_rules)
    .where(
      and(
        eq(organization_permission_rules.organization_id, organizationId),
        eq(organization_permission_rules.id, ruleId)
      )
    )
    .limit(1);
  if (!rule) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rule not found' });
  return rule;
}

async function createRule(params: {
  ctx: { user: Actor };
  organizationId: string;
  tier: PermissionTier;
  permission: string;
  pattern: string;
  description: string | null;
  source: OrganizationPermissionRuleSource;
  auditVerb: 'Added' | 'Approved';
}) {
  const warnings = validateOrThrow(params);
  try {
    return await db.transaction(async tx => {
      const [{ total }] = await tx
        .select({ total: count() })
        .from(organization_permission_rules)
        .where(eq(organization_permission_rules.organization_id, params.organizationId));
      if (total >= MAX_ORGANIZATION_PERMISSION_RULES) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `An organization can have at most ${MAX_ORGANIZATION_PERMISSION_RULES} permission rules.`,
        });
      }
      const [created] = await tx
        .insert(organization_permission_rules)
        .values({
          organization_id: params.organizationId,
          tier: params.tier,
          permission: params.permission,
          pattern: params.pattern,
          description: params.description,
          source: params.source,
          created_by_kilo_user_id: params.ctx.user.id,
          updated_by_kilo_user_id: params.ctx.user.id,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) conflict();
      await createAuditLog({
        action: 'organization.permission_rule.add',
        ...auditEntry(params.ctx, params.organizationId),
        message: `${params.auditVerb} ${describeRule(created)}`,
        tx,
      });
      return { rule: serializeRule(created), warnings };
    });
  } catch (error) {
    if (isUniqueViolation(error)) conflict();
    throw error;
  }
}

function eventFilters(
  organizationId: string,
  filter: { decision?: OrganizationPermissionEventDecision; client?: string; days: number }
) {
  const events = organization_permission_events_daily;
  return and(
    eq(events.organization_id, organizationId),
    gte(events.day, sql`(current_date - ${filter.days}::int)`),
    filter.decision ? eq(events.decision, filter.decision) : undefined,
    filter.client ? eq(events.client, filter.client) : undefined
  );
}

function toIsoString(value: string | Date): string {
  return new Date(value).toISOString();
}

export const organizationPermissionRulesRouter = createTRPCRouter({
  list: organizationAdminProcedure.query(async ({ input }) => {
    const organization = await requireGuardrailsOrganization(input.organizationId);
    const settings = resolvePermissionSettings(organization);
    const rows = await loadRules(input.organizationId);
    return {
      enforcement: settings.enforcement,
      defaultEffect: settings.defaultEffect,
      rules: rows.sort(comparePermissionRules).map(serializeRule),
    };
  }),

  preview: organizationAdminProcedure
    .input(
      z.object({
        permission: PermissionSchema,
        pattern: z.string().min(1).max(MAX_PATTERN_LENGTH),
      })
    )
    .query(async ({ input }) => {
      const organization = await requireGuardrailsOrganization(input.organizationId);
      const settings = resolvePermissionSettings(organization);
      const rows = await loadRules(input.organizationId);
      const result = evaluateOrgDecision(
        { defaultEffect: settings.defaultEffect, rules: rows },
        { permission: input.permission, pattern: input.pattern }
      );
      const rule = result.ruleId ? rows.find(row => row.id === result.ruleId) : undefined;
      return {
        decision: result.decision,
        enforcement: settings.enforcement,
        rule: rule ? serializeRule(rule) : null,
      };
    }),

  listEvents: organizationAdminProcedure
    .input(z.object({ ...EventFilterShape, cursor: z.number().int().min(0).default(0) }))
    .query(async ({ input }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const events = organization_permission_events_daily;
      const lastSeen = sql`max(${events.last_seen_at})`;
      const countOf = (decision: OrganizationPermissionEventDecision) =>
        sql<number>`coalesce(sum(${events.count}) filter (where ${events.decision} = ${decision}), 0)`.mapWith(
          Number
        );
      const rows = await db
        .select({
          permission: events.permission,
          commandKey: events.command_key,
          allowedCount: countOf('allowed'),
          askedCount: countOf('asked'),
          deniedCount: countOf('denied'),
          users: sql<number>`count(distinct ${events.kilo_user_id})`.mapWith(Number),
          clients: sql<string[]>`array_agg(distinct ${events.client})`,
          lastSeenAt: sql<string | Date>`${lastSeen}`.mapWith(toIsoString),
        })
        .from(events)
        .where(eventFilters(input.organizationId, input))
        .groupBy(events.permission, events.command_key)
        .orderBy(desc(lastSeen), asc(events.permission), asc(events.command_key))
        .limit(EVENTS_PAGE_SIZE + 1)
        .offset(input.cursor);

      const page = rows.slice(0, EVENTS_PAGE_SIZE);
      const existing =
        page.length === 0
          ? []
          : await db
              .select({
                permission: organization_permission_rules.permission,
                pattern: organization_permission_rules.pattern,
              })
              .from(organization_permission_rules)
              .where(
                and(
                  eq(organization_permission_rules.organization_id, input.organizationId),
                  inArray(
                    organization_permission_rules.permission,
                    page.map(row => row.permission)
                  )
                )
              );
      const ruleKeys = new Set(existing.map(row => `${row.permission}\u0000${row.pattern}`));
      return {
        events: page.map(row => ({
          ...row,
          hasRule: ruleKeys.has(`${row.permission}\u0000${approvalPattern(row.commandKey)}`),
        })),
        nextCursor: rows.length > EVENTS_PAGE_SIZE ? input.cursor + EVENTS_PAGE_SIZE : null,
      };
    }),

  eventUsers: organizationAdminProcedure
    .input(
      z.object({ ...EventFilterShape, permission: PermissionSchema, commandKey: CommandKeySchema })
    )
    .query(async ({ input }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const events = organization_permission_events_daily;
      const lastSeen = sql`max(${events.last_seen_at})`;
      const rows = await db
        .select({
          userId: events.kilo_user_id,
          name: kilocode_users.google_user_name,
          email: kilocode_users.google_user_email,
          client: events.client,
          decision: events.decision,
          uses: sql<number>`sum(${events.count})`.mapWith(Number),
          lastSeenAt: sql<string | Date>`${lastSeen}`.mapWith(toIsoString),
        })
        .from(events)
        .leftJoin(kilocode_users, eq(kilocode_users.id, events.kilo_user_id))
        .where(
          and(
            eventFilters(input.organizationId, input),
            eq(events.permission, input.permission),
            eq(events.command_key, input.commandKey)
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
        .limit(EVENT_USERS_LIMIT);
      return { users: rows };
    }),

  add: organizationAdminMutationProcedure
    .input(
      OrganizationIdInputSchema.extend({
        ...PermissionRuleInputSchema.shape,
        source: z.enum(['admin_ui', 'preset']).default('admin_ui'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      return await createRule({
        ctx,
        organizationId: input.organizationId,
        tier: input.tier,
        permission: input.permission,
        pattern: input.pattern,
        description: input.description || null,
        source: { type: input.source },
        auditVerb: 'Added',
      });
    }),

  update: organizationAdminMutationProcedure
    .input(RuleIdInputSchema.extend(PermissionRuleInputSchema.partial().shape))
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const rule = await findRule(input.organizationId, input.ruleId);
      const next = {
        tier: input.tier ?? rule.tier,
        permission: input.permission ?? rule.permission,
        pattern: input.pattern ?? rule.pattern,
        description: input.description === undefined ? rule.description : input.description || null,
      };
      const warnings = validateOrThrow(next);
      try {
        return await db.transaction(async tx => {
          const [updated] = await tx
            .update(organization_permission_rules)
            .set({ ...next, updated_by_kilo_user_id: ctx.user.id })
            .where(
              and(
                eq(organization_permission_rules.organization_id, input.organizationId),
                eq(organization_permission_rules.id, rule.id)
              )
            )
            .returning();
          if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rule not found' });
          await createAuditLog({
            action: 'organization.permission_rule.update',
            ...auditEntry(ctx, input.organizationId),
            message: `Updated ${describeRule(rule)} to ${describeRule(updated)}`,
            tx,
          });
          return { rule: serializeRule(updated), warnings };
        });
      } catch (error) {
        if (isUniqueViolation(error)) conflict();
        throw error;
      }
    }),

  delete: organizationAdminMutationProcedure
    .input(RuleIdInputSchema)
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const rule = await findRule(input.organizationId, input.ruleId);
      await db.transaction(async tx => {
        await tx
          .delete(organization_permission_rules)
          .where(
            and(
              eq(organization_permission_rules.organization_id, input.organizationId),
              eq(organization_permission_rules.id, rule.id)
            )
          );
        await createAuditLog({
          action: 'organization.permission_rule.remove',
          ...auditEntry(ctx, input.organizationId),
          message: `Removed ${describeRule(rule)}`,
          tx,
        });
      });
      return { id: rule.id };
    }),

  setEnforcement: organizationAdminMutationProcedure
    .input(
      OrganizationIdInputSchema.extend({
        enforcement: PermissionEnforcementSchema.optional(),
        defaultEffect: PermissionActionSchema.optional(),
      }).refine(
        input => input.enforcement !== undefined || input.defaultEffect !== undefined,
        'Set enforcement or defaultEffect.'
      )
    )
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      return await db.transaction(async tx => {
        const settings = await mutateOrganizationSettings(
          input.organizationId,
          latest => {
            const current = resolvePermissionSettings(latest);
            return {
              ...latest.settings,
              guardrails: {
                ...latest.settings.guardrails,
                permissions: {
                  enforcement: input.enforcement ?? current.enforcement,
                  default_effect: input.defaultEffect ?? current.defaultEffect,
                },
              },
            };
          },
          tx
        );
        const next = resolvePermissionSettings({ settings });
        await createAuditLog({
          action: 'organization.settings.change',
          ...auditEntry(ctx, input.organizationId),
          message: `Set permission enforcement to ${next.enforcement}, default ${next.defaultEffect}`,
          tx,
        });
        return next;
      });
    }),

  approveEvent: organizationAdminMutationProcedure
    .input(z.object({ permission: PermissionSchema, commandKey: CommandKeySchema }))
    .mutation(async ({ input, ctx }) => {
      await requireGuardrailsOrganization(input.organizationId);
      const events = organization_permission_events_daily;
      const [seen] = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.organization_id, input.organizationId),
            eq(events.permission, input.permission),
            eq(events.command_key, input.commandKey)
          )
        )
        .limit(1);
      if (!seen) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No usage found for this command.' });
      }
      return await createRule({
        ctx,
        organizationId: input.organizationId,
        tier: 'narrow_allow',
        permission: input.permission,
        pattern: approvalPattern(input.commandKey),
        description: null,
        source: { type: 'event_approval' },
        auditVerb: 'Approved',
      });
    }),
});
