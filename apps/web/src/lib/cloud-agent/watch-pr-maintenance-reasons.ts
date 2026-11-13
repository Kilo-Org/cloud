export type MaintenanceRecoveryAction =
  | 'resume'
  | 'recheck_after_fix'
  | 'reenable'
  | 'manual'
  | 'none';

export const maintenanceRecoveryActions = {
  user_pause: 'resume',
  ready_to_resume: 'resume',
  maintenance_chat_stopped: 'resume',
  user_stop: 'reenable',
  expired: 'reenable',
  total_attempt_limit: 'manual',
  problem_attempt_limit: 'manual',
  maintenance_workspace_settings_changed: 'reenable',
  maintenance_pr_identity_changed: 'reenable',
  maintenance_purpose_unavailable: 'recheck_after_fix',
  maintenance_parent_commit_unavailable: 'recheck_after_fix',
  maintenance_access_unavailable: 'recheck_after_fix',
  maintenance_balance_unavailable: 'recheck_after_fix',
  maintenance_precondition_changed: 'recheck_after_fix',
  pr_assessment_unavailable: 'recheck_after_fix',
  pr_observation_incomplete: 'recheck_after_fix',
  conflict_state_unknown: 'recheck_after_fix',
  publication_unverified: 'manual',
  maintenance_verification_failed: 'manual',
  maintenance_verification_unavailable: 'manual',
  maintenance_result_unavailable_after_publication: 'manual',
  maintenance_result_unavailable_after_answer: 'manual',
  maintenance_github_action_blocked: 'manual',
  maintenance_runtime_state_unavailable: 'recheck_after_fix',
  maintenance_attempt_timeout: 'resume',
  delivery_attempt_limit: 'resume',
  missing_stable_session_identity: 'manual',
  source_worktree_deleted: 'none',
  pr_closed: 'none',
  pr_merged: 'none',
  reviewer_approval_required: 'manual',
  waiting_for_clean_checkout: 'none',
  remote_head_changed_reassessing: 'none',
  rate_limited: 'none',
  low_budget: 'none',
  throttled: 'none',
  write_pacing: 'none',
  unavailable: 'none',
  user_session_active: 'none',
  maintenance_session_active: 'none',
  maintenance_question: 'manual',
  pr_assessment_retry: 'none',
  maintenance_delivery_retry: 'none',
  conflict_state_pending: 'none',
} satisfies Record<string, MaintenanceRecoveryAction>;

export type MaintenanceReason = keyof typeof maintenanceRecoveryActions;

export function getMaintenanceRecoveryAction(
  reason: string | null | undefined
): MaintenanceRecoveryAction {
  if (!reason) return 'none';
  return Object.prototype.hasOwnProperty.call(maintenanceRecoveryActions, reason)
    ? maintenanceRecoveryActions[reason as keyof typeof maintenanceRecoveryActions]
    : 'manual';
}
