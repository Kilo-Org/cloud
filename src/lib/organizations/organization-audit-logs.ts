import type { AuditLog } from '@kilocode/db/schema';
import { organization_audit_logs } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';

// Re-export from base file that doesn't depend on schema.ts
export { AuditLogAction } from './audit-log-actions';
import type { AuditLogAction } from './audit-log-actions';

export async function createAuditLog({
  action,
  actor_email,
  actor_id,
  actor_name,
  message,
  organization_id,
  tx,
}: Omit<AuditLog, 'action' | 'created_at' | 'id'> & {
  action: AuditLogAction;
  tx?: DrizzleTransaction;
}): Promise<AuditLog> {
  const [auditLog] = await (tx ?? db)
    .insert(organization_audit_logs)
    .values({
      action,
      actor_email,
      actor_id,
      actor_name,
      message,
      organization_id,
    })
    .returning();

  return auditLog;
}
