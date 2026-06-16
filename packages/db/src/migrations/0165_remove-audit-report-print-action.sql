ALTER TABLE "security_audit_log" DROP CONSTRAINT "security_audit_log_action_check";--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_action_check" CHECK ("security_audit_log"."action" IN ('security.finding.created', 'security.finding.severity_changed', 'security.finding.status_change', 'security.finding.dismissed', 'security.finding.auto_dismissed', 'security.finding.superseded', 'security.finding.analysis_started', 'security.finding.analysis_completed', 'security.finding.analysis_failed', 'security.remediation.queued', 'security.remediation.started', 'security.remediation.pr_opened', 'security.remediation.failed', 'security.remediation.blocked', 'security.remediation.no_changes_needed', 'security.remediation.cancelled', 'security.remediation.retried', 'security.finding.deleted', 'security.config.enabled', 'security.config.disabled', 'security.config.updated', 'security.sync.triggered', 'security.sync.completed', 'security.audit_log.exported', 'security.audit_report.generated'));
--> statement-breakpoint
UPDATE "security_audit_log"
SET
  "actor_email" = "kilocode_users"."google_user_email",
  "actor_name" = "kilocode_users"."google_user_name"
FROM "kilocode_users"
WHERE "security_audit_log"."actor_id" = "kilocode_users"."id"
  AND "security_audit_log"."resource_type" = 'security_finding'
  AND "security_audit_log"."actor_name" IS NULL;