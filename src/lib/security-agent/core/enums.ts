/**
 * Actions logged in the security_audit_log table.
 *
 * Follows a consistent 3-segment `security.entity.verb` pattern.
 * Registered in SCHEMA_CHECK_ENUMS (src/db/schema.ts) and enforced
 * at the database level via enumCheck.
 */
export enum SecurityAuditLogAction {
  FindingCreated = 'security.finding.created',
  FindingStatusChange = 'security.finding.status_change',
  FindingDismissed = 'security.finding.dismissed',
  FindingAutoDismissed = 'security.finding.auto_dismissed',
  FindingAnalysisStarted = 'security.finding.analysis_started',
  FindingAnalysisCompleted = 'security.finding.analysis_completed',
  FindingDeleted = 'security.finding.deleted',
  ConfigEnabled = 'security.config.enabled',
  ConfigDisabled = 'security.config.disabled',
  ConfigUpdated = 'security.config.updated',
  SyncTriggered = 'security.sync.triggered',
  SyncCompleted = 'security.sync.completed',
  AuditLogExported = 'security.audit_log.exported',
}
