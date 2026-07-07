import { logger } from './logger.js';

export type WorkspaceBackupOperation = 'restore' | 'create';
export type WorkspaceBackupDisabledReason = 'invalid_worker_url';

export type WorkspaceBackupFailureCategory =
  | 'workspace_cleanup_failed'
  | 'workspace_parent_prepare_failed'
  | 'backup_restore_failed'
  | 'backup_validation_failed'
  | 'fallback_cleanup_failed'
  | 'source_commit_read_failed'
  | 'active_origin_read_failed'
  | 'canonical_origin_set_failed'
  | 'backup_create_failed'
  | 'authenticated_origin_restore_failed'
  | 'backup_record_create_failed'
  | 'index_write_failed';

export type WorkspaceBackupLifecycleEvent =
  | {
      operation: WorkspaceBackupOperation;
      outcome: 'started';
    }
  | {
      operation: WorkspaceBackupOperation;
      outcome: 'completed';
      durationMs: number;
    }
  | {
      operation: WorkspaceBackupOperation;
      outcome: 'failed';
      durationMs: number;
      failureCategory: WorkspaceBackupFailureCategory;
    };

export function logWorkspaceBackupDisabled(reason: WorkspaceBackupDisabledReason): void {
  try {
    const eventName = 'workspace_backup.configuration.disabled';
    logger.withTags({ logTag: eventName }).withFields({ reason }).warn(eventName);
  } catch {
    return;
  }
}

export function logWorkspaceBackupLifecycle(event: WorkspaceBackupLifecycleEvent): void {
  try {
    const eventName = `workspace_backup.${event.operation}.${event.outcome}`;
    const eventLogger = logger.withTags({ logTag: eventName }).withFields(event);
    if (event.outcome === 'failed') {
      eventLogger.warn(eventName);
      return;
    }
    eventLogger.info(eventName);
  } catch {
    return;
  }
}
