import * as z from 'zod';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationOwnerProcedure,
} from '@/routers/organizations/utils';
import { security_audit_log } from '@/db/schema';
import { db } from '@/lib/drizzle';
import {
  and,
  eq,
  lt,
  gt,
  desc,
  asc,
  count,
  min,
  max,
  ilike,
  gte,
  lte,
  inArray,
  sql,
} from 'drizzle-orm';
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';
import {
  logSecurityAudit,
  maskKiloAdminActors,
} from '@/lib/security-agent/services/audit-log-service';

const PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 10_000;

const SecurityAuditLogActionSchema = z.nativeEnum(SecurityAuditLogAction);

const ListSecurityAuditLogsInputSchema = OrganizationIdInputSchema.extend({
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  action: z.array(SecurityAuditLogActionSchema).optional(),
  actorEmail: z.string().email().optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(500).optional(),
  fuzzySearch: z.string().max(200).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
});

const ExportInputSchema = OrganizationIdInputSchema.extend({
  format: z.enum(['csv', 'json']).default('json'),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  action: z.array(SecurityAuditLogActionSchema).optional(),
});

export const organizationSecurityAuditLogRouter = createTRPCRouter({
  list: organizationOwnerProcedure
    .input(ListSecurityAuditLogsInputSchema)
    .query(async ({ input, ctx }) => {
      const {
        organizationId,
        before,
        after,
        action,
        actorEmail,
        resourceType,
        resourceId,
        fuzzySearch,
        startTime,
        endTime,
      } = input;

      const whereConditions = [eq(security_audit_log.owned_by_organization_id, organizationId)];

      if (action && action.length > 0) {
        if (action.length === 1) {
          whereConditions.push(eq(security_audit_log.action, action[0]));
        } else {
          whereConditions.push(inArray(security_audit_log.action, action));
        }
      }
      if (actorEmail) whereConditions.push(eq(security_audit_log.actor_email, actorEmail));
      if (resourceType) whereConditions.push(eq(security_audit_log.resource_type, resourceType));
      if (resourceId) whereConditions.push(eq(security_audit_log.resource_id, resourceId));
      if (fuzzySearch) {
        const escapedSearch = fuzzySearch.replace(/[%_\\]/g, '\\$&');
        whereConditions.push(
          ilike(sql`COALESCE(${security_audit_log.metadata}::text, '')`, `%${escapedSearch}%`)
        );
      }
      if (startTime) whereConditions.push(gte(security_audit_log.created_at, startTime));
      if (endTime) whereConditions.push(lte(security_audit_log.created_at, endTime));

      if (before) whereConditions.push(lt(security_audit_log.created_at, before));
      if (after) whereConditions.push(gt(security_audit_log.created_at, after));

      const orderBy = after
        ? asc(security_audit_log.created_at)
        : desc(security_audit_log.created_at);

      const logs = await db
        .select({
          id: security_audit_log.id,
          action: security_audit_log.action,
          actor_id: security_audit_log.actor_id,
          actor_email: security_audit_log.actor_email,
          actor_name: security_audit_log.actor_name,
          resource_type: security_audit_log.resource_type,
          resource_id: security_audit_log.resource_id,
          before_state: security_audit_log.before_state,
          after_state: security_audit_log.after_state,
          metadata: security_audit_log.metadata,
          created_at: security_audit_log.created_at,
        })
        .from(security_audit_log)
        .where(and(...whereConditions))
        .orderBy(orderBy)
        .limit(PAGE_SIZE + 1);

      if (after && logs.length > 0) {
        logs.reverse();
      }

      const hasMore = logs.length > PAGE_SIZE;
      const resultLogs = hasMore ? logs.slice(0, PAGE_SIZE) : logs;

      const isKiloAdmin = ctx.user.google_user_email.endsWith('@kilocode.ai');
      const maskedLogs = maskKiloAdminActors(resultLogs, isKiloAdmin);

      const hasNext = hasMore;
      const hasPrevious = !!after || (!!before && logs.length > 0);

      const oldestTimestamp =
        maskedLogs.length > 0
          ? new Date(maskedLogs[maskedLogs.length - 1].created_at).toISOString()
          : null;
      const newestTimestamp =
        maskedLogs.length > 0 ? new Date(maskedLogs[0].created_at).toISOString() : null;

      return {
        logs: maskedLogs,
        hasNext,
        hasPrevious,
        oldestTimestamp,
        newestTimestamp,
      };
    }),

  getActionTypes: organizationOwnerProcedure.input(OrganizationIdInputSchema).query(async () => {
    return Object.values(SecurityAuditLogAction);
  }),

  getSummary: organizationOwnerProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input }) => {
      const { organizationId } = input;

      const [summary] = await db
        .select({
          totalEvents: count(security_audit_log.id),
          earliestEvent: min(security_audit_log.created_at),
          latestEvent: max(security_audit_log.created_at),
        })
        .from(security_audit_log)
        .where(eq(security_audit_log.owned_by_organization_id, organizationId));

      return {
        totalEvents: summary.totalEvents || 0,
        earliestEvent: summary.earliestEvent,
        latestEvent: summary.latestEvent,
      };
    }),

  export: organizationOwnerProcedure.input(ExportInputSchema).mutation(async ({ input, ctx }) => {
    const { organizationId, format, startTime, endTime, action } = input;

    const whereConditions = [eq(security_audit_log.owned_by_organization_id, organizationId)];
    if (startTime) whereConditions.push(gte(security_audit_log.created_at, startTime));
    if (endTime) whereConditions.push(lte(security_audit_log.created_at, endTime));
    if (action && action.length > 0) {
      if (action.length === 1) {
        whereConditions.push(eq(security_audit_log.action, action[0]));
      } else {
        whereConditions.push(inArray(security_audit_log.action, action));
      }
    }

    const logs = await db
      .select()
      .from(security_audit_log)
      .where(and(...whereConditions))
      .orderBy(desc(security_audit_log.created_at))
      .limit(MAX_EXPORT_ROWS);

    // Log the export action itself
    logSecurityAudit({
      owner: { organizationId },
      actor_id: ctx.user.id,
      actor_email: ctx.user.google_user_email,
      actor_name: ctx.user.google_user_name,
      action: SecurityAuditLogAction.AuditLogExported,
      resource_type: 'audit_log',
      resource_id: organizationId,
      metadata: { format, rowCount: logs.length, startTime, endTime },
    });

    const isKiloAdmin = ctx.user.google_user_email.endsWith('@kilocode.ai');
    const maskedLogs = maskKiloAdminActors(logs, isKiloAdmin);

    if (format === 'csv') {
      const header =
        'id,timestamp,action,actor_id,actor_email,actor_name,resource_type,resource_id,before_state,after_state,metadata';
      const rows = maskedLogs.map(log =>
        [
          log.id,
          log.created_at,
          log.action,
          log.actor_id ?? '',
          log.actor_email ?? '',
          log.actor_name ?? '',
          log.resource_type,
          log.resource_id,
          log.before_state ? JSON.stringify(log.before_state) : '',
          log.after_state ? JSON.stringify(log.after_state) : '',
          log.metadata ? JSON.stringify(log.metadata) : '',
        ]
          .map(field => `"${String(field).replace(/"/g, '""')}"`)
          .join(',')
      );
      return {
        format: 'csv' as const,
        data: [header, ...rows].join('\n'),
        rowCount: maskedLogs.length,
      };
    }

    return {
      format: 'json' as const,
      data: JSON.stringify(maskedLogs, null, 2),
      rowCount: maskedLogs.length,
    };
  }),
});
