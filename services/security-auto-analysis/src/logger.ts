import { WorkersLogger } from 'workers-tagged-logger';

export type DispatcherStage =
  | 'stale_analysis_queue_reconciliation'
  | 'stale_command_reconciliation'
  | 'retained_command_deletion'
  | 'due_owner_discovery'
  | 'owner_queue_sends'
  | 'remediation_attempt_discovery'
  | 'remediation_queue_sends';

export type SecurityAutoAnalysisLogTags = {
  event_name: string;
  dispatcher_stage?: DispatcherStage;
  dispatch_id?: string;
  outcome?: 'attempted' | 'succeeded' | 'failed' | 'skipped' | 'timeout';
  heartbeat_kind?: 'success' | 'failure';
  exception_name?: string;
  error_message?: string;
  elapsed_ms?: number;
  worker_environment?: string;
  worker_version?: string;
  response_status?: number;
  response_status_class?: string;
  requeued_pending_count?: number;
  failed_running_count?: number;
  stale_accepted_command_count?: number;
  stale_running_command_count?: number;
  deleted_terminal_command_count?: number;
  discovered_owner_count?: number;
  enqueued_owner_message_count?: number;
  discovered_remediation_attempt_count?: number;
  enqueued_remediation_message_count?: number;
};

export function sanitizedExceptionName(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : 'Error';
}

function getLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
  if (typeof process !== 'undefined' && process.env?.VITEST) {
    return 'error';
  }

  return 'info';
}

export const logger = new WorkersLogger<SecurityAutoAnalysisLogTags>({
  minimumLogLevel: getLogLevel(),
});
