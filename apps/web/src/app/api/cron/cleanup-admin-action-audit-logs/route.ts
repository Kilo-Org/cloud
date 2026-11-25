import { admin_action_audit_logs } from '@kilocode/db/schema';
import { auditLogRetentionCron } from '@/lib/audit-log-retention';

export const maxDuration = 300;

export const GET = auditLogRetentionCron({
  jobName: 'web.cleanup_admin_action_audit_logs',
  deletedCountField: 'deleted_admin_action_audit_logs_count',
  source: {
    table: admin_action_audit_logs,
    id: admin_action_audit_logs.id,
    createdAt: admin_action_audit_logs.created_at,
  },
});
