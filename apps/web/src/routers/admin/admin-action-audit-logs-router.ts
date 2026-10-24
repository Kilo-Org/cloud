import { and, desc, eq, ilike, lt, or, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { admin_action_audit_logs } from '@kilocode/db/schema';
import { AdminActionAuditAction, AdminActionAuditTargetType } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { superadminProcedure } from '@/lib/trpc/admin-procedures';

const CursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

export const AdminActionAuditLogListInputSchema = z.object({
  action: AdminActionAuditAction.optional(),
  actorEmail: z.string().trim().min(1).max(320).optional(),
  targetType: AdminActionAuditTargetType.optional(),
  targetId: z.string().trim().min(1).max(1024).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
});

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

export const adminActionAuditLogsRouter = createTRPCRouter({
  list: superadminProcedure.input(AdminActionAuditLogListInputSchema).query(async ({ input }) => {
    const conditions: SQL[] = [];
    if (input.action) conditions.push(eq(admin_action_audit_logs.action, input.action));
    if (input.actorEmail) {
      conditions.push(ilike(admin_action_audit_logs.actor_email, escapeLike(input.actorEmail)));
    }
    if (input.targetType) {
      conditions.push(eq(admin_action_audit_logs.target_type, input.targetType));
    }
    if (input.targetId) conditions.push(eq(admin_action_audit_logs.target_id, input.targetId));
    if (input.search) {
      conditions.push(ilike(admin_action_audit_logs.message, `%${escapeLike(input.search)}%`));
    }
    if (input.cursor) {
      const before = or(
        lt(admin_action_audit_logs.created_at, input.cursor.createdAt),
        and(
          eq(admin_action_audit_logs.created_at, input.cursor.createdAt),
          lt(admin_action_audit_logs.id, input.cursor.id)
        )
      );
      if (before) conditions.push(before);
    }

    const rows = await db
      .select()
      .from(admin_action_audit_logs)
      .where(and(...conditions))
      .orderBy(desc(admin_action_audit_logs.created_at), desc(admin_action_audit_logs.id))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit).map(row => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      actorName: row.actor_name,
      targetType: row.target_type,
      targetId: row.target_id,
      message: row.message,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    const last = page.at(-1);

    return {
      rows: page,
      nextCursor:
        rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }),
});
