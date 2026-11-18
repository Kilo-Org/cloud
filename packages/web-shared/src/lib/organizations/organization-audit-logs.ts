import type { AuditLog } from '@kilocode/db/schema';
import { organization_audit_logs } from '@kilocode/db/schema';
import type { AuditLogAction, OrganizationAuditLogDetails } from '@kilocode/db/schema-types';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { db } from '@kilocode/web-shared/lib/drizzle';

// Re-export from base file that doesn't depend on schema.ts
export { AuditLogAction } from './audit-log-actions';

/**
 * `details` carries the entry's facts as structured data (ids, counts, booleans — no prose) so a
 * client can build the sentence in the reader's language; see
 * `OrganizationAuditLogDetailsSchema`. `message` stays the authoritative English prose for the
 * web audit page.
 */
export async function createAuditLog({
  action,
  actor_email,
  actor_id,
  actor_name,
  message,
  details,
  organization_id,
  tx,
}: Omit<AuditLog, 'action' | 'details' | 'created_at' | 'id'> & {
  action: AuditLogAction;
  details?: OrganizationAuditLogDetails | null;
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
      details: details ?? null,
      organization_id,
    })
    .returning();

  return auditLog;
}
