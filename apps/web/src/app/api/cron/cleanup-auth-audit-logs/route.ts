import { auth_audit_logs } from '@kilocode/db/schema';
import { auditLogRetentionCron } from '@/lib/audit-log-retention';

export const maxDuration = 300;

export const GET = auditLogRetentionCron({
  jobName: 'web.cleanup_auth_audit_logs',
  deletedCountField: 'deleted_auth_audit_logs_count',
  source: {
    table: auth_audit_logs,
    id: auth_audit_logs.id,
    createdAt: auth_audit_logs.created_at,
  },
});
