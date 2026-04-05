import 'server-only';

import type { KiloClawAdminAuditLog } from '@kilocode/db/schema';
import { kiloclaw_admin_audit_logs } from '@kilocode/db/schema';
import type { KiloClawAdminAuditAction } from '@kilocode/db/schema-types';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { eq, desc, and } from 'drizzle-orm';

export async function createKiloClawAdminAuditLog({
  action,
  actor_id,
  actor_email,
  actor_name,
  target_user_id,
  message,
  metadata,
  tx,
}: Omit<KiloClawAdminAuditLog, 'action' | 'created_at' | 'id'> & {
  action: KiloClawAdminAuditAction;
  tx?: DrizzleTransaction;
}): Promise<KiloClawAdminAuditLog> {
  const [auditLog] = await (tx ?? db)
    .insert(kiloclaw_admin_audit_logs)
    .values({
      action,
      actor_id,
      actor_email,
      actor_name,
      target_user_id,
      message,
      metadata,
    })
    .returning();

  return auditLog;
}

export async function listKiloClawAdminAuditLogs({
  target_user_id,
  action,
  limit = 10,
}: {
  target_user_id: string;
  action?: KiloClawAdminAuditAction;
  limit?: number;
}): Promise<KiloClawAdminAuditLog[]> {
  return db
    .select()
    .from(kiloclaw_admin_audit_logs)
    .where(
      action
        ? and(
            eq(kiloclaw_admin_audit_logs.target_user_id, target_user_id),
            eq(kiloclaw_admin_audit_logs.action, action)
          )
        : eq(kiloclaw_admin_audit_logs.target_user_id, target_user_id)
    )
    .orderBy(desc(kiloclaw_admin_audit_logs.created_at))
    .limit(limit);
}
