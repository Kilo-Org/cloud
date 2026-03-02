import * as z from 'zod';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationOwnerProcedure,
} from '@/routers/organizations/utils';
import { organization_audit_logs } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { and, eq, lt, gt, desc, asc, count, min, max, ilike, gte, lte, inArray } from 'drizzle-orm';
import { AuditLogAction } from '@/lib/organizations/organization-audit-logs';

const PAGE_SIZE = 100;

const ListAuditLogsInputSchema = OrganizationIdInputSchema.extend({
  before: z.string().datetime().optional(), // For next page (older events)
  after: z.string().datetime().optional(), // For previous page (newer events)
  action: z.array(AuditLogAction).optional(),
  actorEmail: z.string().email().optional(),
  fuzzySearch: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
});

type AuditLogWithPagination = {
  id: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  message: string;
  created_at: string;
};

type AuditLogsResponse = {
  logs: AuditLogWithPagination[];
  hasNext: boolean;
  hasPrevious: boolean;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
};

export const organizationAuditLogRouter = createTRPCRouter({
  list: organizationOwnerProcedure.input(ListAuditLogsInputSchema).query(async ({ input, ctx }) => {
    const { organizationId, before, after, action, actorEmail, fuzzySearch, startTime, endTime } =
      input;

    // Build the where conditions for pagination and filtering
    const whereConditions = [eq(organization_audit_logs.organization_id, organizationId)];

    if (action && action.length > 0) {
      if (action.length === 1) {
        whereConditions.push(eq(organization_audit_logs.action, action[0]));
      } else {
        whereConditions.push(inArray(organization_audit_logs.action, action));
      }
    }
    if (actorEmail) whereConditions.push(eq(organization_audit_logs.actor_email, actorEmail));
    if (fuzzySearch)
      whereConditions.push(ilike(organization_audit_logs.message, `%${fuzzySearch}%`));
    if (startTime) whereConditions.push(gte(organization_audit_logs.created_at, startTime));
    if (endTime) whereConditions.push(lte(organization_audit_logs.created_at, endTime));

    if (before) {
      whereConditions.push(lt(organization_audit_logs.created_at, before));
    }
    if (after) {
      whereConditions.push(gt(organization_audit_logs.created_at, after));
    }

    // Determine sort order based on pagination direction
    const orderBy = after
      ? asc(organization_audit_logs.created_at) // When going back (previous page), fetch oldest first
      : desc(organization_audit_logs.created_at); // Default and next page, fetch newest first

    // Fetch one extra record to determine if there are more pages
    const logs = await db
      .select({
        id: organization_audit_logs.id,
        action: organization_audit_logs.action,
        actor_id: organization_audit_logs.actor_id,
        actor_email: organization_audit_logs.actor_email,
        actor_name: organization_audit_logs.actor_name,
        message: organization_audit_logs.message,
        created_at: organization_audit_logs.created_at,
      })
      .from(organization_audit_logs)
      .where(and(...whereConditions))
      .orderBy(orderBy)
      .limit(PAGE_SIZE + 1);

    // If we were going backwards (after parameter), reverse the results to show newest first
    if (after && logs.length > 0) {
      logs.reverse();
    }

    // Check if there are more pages
    const hasMore = logs.length > PAGE_SIZE;
    const resultLogs = hasMore ? logs.slice(0, PAGE_SIZE) : logs;

    // Mask Kilo Code admin information unless the requesting user is a Kilo admin
    const isRequestingUserKiloAdmin = ctx.user.google_user_email.endsWith('@kilocode.ai');
    const maskedLogs = isRequestingUserKiloAdmin
      ? resultLogs
      : resultLogs.map(log => {
          // Check if the actor is a Kilo admin
          if (log.actor_email && log.actor_email.endsWith('@kilocode.ai')) {
            return {
              ...log,
              actor_id: '00000000-0000-0000-0000-000000000000',
              actor_email: 'admin@kilocode.ai',
              actor_name: 'Kilo Admin',
            };
          }
          return log;
        });

    // Determine pagination flags
    const hasNext = hasMore; // Has older events
    const hasPrevious = !!after || (!!before && logs.length > 0); // Has newer events

    // Get boundary timestamps for pagination (convert to ISO 8601 format)
    const oldestTimestamp =
      maskedLogs.length > 0
        ? new Date(maskedLogs[maskedLogs.length - 1].created_at).toISOString()
        : null;
    const newestTimestamp =
      maskedLogs.length > 0 ? new Date(maskedLogs[0].created_at).toISOString() : null;

    const response: AuditLogsResponse = {
      logs: maskedLogs,
      hasNext,
      hasPrevious,
      oldestTimestamp,
      newestTimestamp,
    };

    return response;
  }),

  // Get all possible action types from the AuditLogAction enum
  getActionTypes: organizationOwnerProcedure.input(OrganizationIdInputSchema).query(async () => {
    // Return all possible action types from the enum
    return AuditLogAction.options;
  }),

  // Get audit log summary statistics
  getSummary: organizationOwnerProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input }) => {
      const { organizationId } = input;

      const [summary] = await db
        .select({
          totalEvents: count(organization_audit_logs.id),
          earliestEvent: min(organization_audit_logs.created_at),
          latestEvent: max(organization_audit_logs.created_at),
        })
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));

      return {
        totalEvents: summary.totalEvents || 0,
        earliestEvent: summary.earliestEvent,
        latestEvent: summary.latestEvent,
      };
    }),
});
