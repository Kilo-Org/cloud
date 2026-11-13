import type {
  WatchPrExecutionStatus,
  WatchPrPublicationEvidence,
  WatchPrStatus,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import {
  getMaintenanceRecoveryAction,
  type MaintenanceReason,
} from '@/lib/cloud-agent/watch-pr-maintenance-reasons';

export const maintenanceStatusLabels: Record<WatchPrExecutionStatus | WatchPrStatus, string> = {
  watching: 'Watching',
  waiting_for_session: 'Waiting for chats',
  fixing: 'Fixing',
  waiting_for_checks: 'Waiting for checks',
  needs_input: 'Needs your input',
  paused: 'Paused',
  finished: 'Finished',
};

export function getMaintenanceStatusLabel(watch: {
  status: WatchPrStatus;
  execution_status: WatchPrExecutionStatus;
}): string {
  return maintenanceStatusLabels[
    watch.status === 'watching' ? watch.execution_status : watch.status
  ];
}

export function getMaintenanceRefetchInterval(
  watch: { status: WatchPrStatus } | null | undefined
): number | false {
  return watch && watch.status !== 'finished' ? 5_000 : false;
}

export function getMaintenanceExecutionHelp(watch: {
  status: WatchPrStatus;
  execution_status: WatchPrExecutionStatus;
  policy: { version: 1 | 2 };
  activeChat: { chatAvailable: boolean } | null;
}): string | null {
  if (watch.status !== 'watching' || watch.policy.version !== 2) return null;
  if (watch.execution_status === 'waiting_for_session') {
    return 'Auto-fix waits for your running chats and the workspace quiet period.';
  }
  if (watch.execution_status === 'needs_input' && !watch.activeChat?.chatAvailable) {
    return 'Resolve the reported blocker, then recheck the PR. No auto-fix chat needs an answer.';
  }
  return null;
}

export function getMaintenanceEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function getMaintenanceControlsState(
  watch:
    | {
        status: WatchPrStatus;
        policy: { version: 1 | 2 };
        lifecycle_reason: string | null;
        rateLimitRetryAt: string | null;
      }
    | null
    | undefined,
  now = Date.now()
) {
  const automatic = watch?.policy.version === 2;
  return {
    automatic,
    enabled: automatic && watch.status !== 'finished',
    legacyWatchActive: watch?.policy.version === 1 && watch.status !== 'finished',
    canResume:
      automatic &&
      watch.status === 'paused' &&
      getMaintenanceRecoveryAction(watch.lifecycle_reason) === 'resume',
    waitingForBudget: Boolean(watch?.rateLimitRetryAt && Date.parse(watch.rateLimitRetryAt) > now),
  };
}

const recoveryMessages: Record<MaintenanceReason, string> = {
  user_pause: 'Auto-fix is paused. Select Resume to continue.',
  ready_to_resume: 'Readiness checks passed. Select Resume to continue auto-fix.',
  user_stop: 'Auto-fix is stopped. Enable it again to continue.',
  expired: 'The observation watch expired. Enable auto-fix to continue.',
  maintenance_chat_stopped: 'You stopped the auto-fix chat. Select Resume to continue.',
  user_session_active: 'Auto-fix waits for your chats and the workspace quiet period.',
  conflict_state_unknown:
    'GitHub could not determine merge conflicts. Inspect the PR, then recheck.',
  delivery_attempt_limit: 'Auto-fix could not start. Check workspace access, then select Resume.',
  problem_attempt_limit:
    'A problem reached its attempt limit. Open its auto-fix chat and resolve the blocker.',
  publication_unverified:
    'The push result is not verified. Inspect the remote branch and auto-fix chat, then select Recheck.',
  maintenance_attempt_timeout:
    'Auto-fix exceeded its time limit. Inspect its chat and workspace before you resume.',
  total_attempt_limit:
    'The PR reached its attempt limit. Inspect the auto-fix chats and fix the PR manually.',
  source_worktree_deleted: 'The workspace is unavailable. Auto-fix cannot continue.',
  pr_closed: 'The PR is closed. Auto-fix has finished.',
  pr_merged: 'The PR is merged. Auto-fix has finished.',
  maintenance_question:
    'Open the auto-fix chat and answer its question. Your answer continues the same chat.',
  maintenance_workspace_settings_changed:
    'Workspace settings or the model changed. Stop auto-fix, check your settings, then enable it again.',
  maintenance_pr_identity_changed:
    'The linked PR or branch changed. Stop auto-fix, verify the workspace PR, then enable it again.',
  maintenance_purpose_unavailable:
    'Restore a clear workspace task and PR description, then select Recheck. Otherwise stop auto-fix and use a chat with a clear task.',
  maintenance_parent_commit_unavailable:
    'Restore the stacked workspace parent commit, then select Recheck. Otherwise stop auto-fix and fix the workspace manually.',
  maintenance_access_unavailable:
    'Restore repository access and the GitHub connection, then Recheck.',
  maintenance_balance_unavailable:
    'Auto-fix needs at least $1 in credits. Add credits, then select Recheck. To change models, stop auto-fix and update your settings.',
  maintenance_precondition_changed:
    'Workspace or PR requirements changed. Correct the reported change, then Recheck.',
  pr_assessment_unavailable:
    'GitHub PR assessment is unavailable. Check the connection and PR access, then Recheck.',
  pr_observation_incomplete:
    'GitHub feedback is incomplete. Check PR access and wait for GitHub to recover, then Recheck.',
  maintenance_verification_failed:
    'Auto-fix verification failed. Inspect the chat, fix the failure, then select Recheck.',
  maintenance_verification_unavailable:
    'Auto-fix could not verify its changes. Inspect the chat and verify the changes manually, then select Recheck.',
  maintenance_result_unavailable_after_publication:
    'A push was observed, but its repair result is missing. Inspect the remote branch and chat, then Stop and enable auto-fix again.',
  maintenance_result_unavailable_after_answer:
    'Your answer completed, but its repair result is missing. Inspect the chat, then Stop and enable auto-fix again.',
  maintenance_github_action_blocked:
    'A GitHub reply or thread update is blocked. Inspect the PR and GitHub access before rechecking.',
  maintenance_runtime_state_unavailable:
    'The auto-fix chat state is unavailable. Check the workspace and chat, then select Recheck.',
  missing_stable_session_identity:
    'The auto-fix chat identity is incomplete. Inspect the workspace and contact support before starting another repair.',
  reviewer_approval_required:
    'The PR needs human approval. Request it on GitHub. Auto-fix can continue.',
  waiting_for_clean_checkout:
    'Auto-fix waits for a clean checkout and the workspace quiet period. Keep unrelated changes safe.',
  remote_head_changed_reassessing:
    'The remote branch changed. Auto-fix will fetch and check it before another attempt.',
  rate_limited: 'Auto-fix waits for the GitHub rate limit to reset.',
  low_budget: 'Auto-fix waits for available GitHub API budget.',
  throttled: 'Auto-fix waits before the next GitHub refresh.',
  write_pacing: 'Auto-fix waits before the next GitHub reply or thread update.',
  unavailable: 'GitHub is temporarily unavailable. Auto-fix will retry within its limits.',
  maintenance_session_active: 'Another auto-fix chat is active. Auto-fix waits for it to finish.',
  pr_assessment_retry:
    'PR assessment will retry within its limits. No repair starts from missing evidence.',
  maintenance_delivery_retry:
    'The auto-fix chat request will retry. No duplicate repair is requested.',
  conflict_state_pending:
    'GitHub is still checking merge conflicts. Auto-fix waits for the next check.',
};

export function getMaintenanceRecoveryMessage(reason: string | null): string | null {
  if (!reason) return null;
  return Object.prototype.hasOwnProperty.call(recoveryMessages, reason)
    ? recoveryMessages[reason as keyof typeof recoveryMessages]
    : `${reason.replaceAll('_', ' ')}. Inspect the auto-fix chat and PR before rechecking.`;
}

export function getMaintenancePublicationLabel(
  publication: WatchPrPublicationEvidence | null | undefined
): string {
  if (!publication) return 'No verified publication result';
  switch (publication.status) {
    case 'published':
      return `Published ${publication.pushedHeadSha.slice(0, 7)}; remote commit verified`;
    case 'failed':
      return 'Push failed';
    case 'unknown':
      return 'Push outcome unknown';
    case 'not_attempted':
      return 'No push attempted';
  }
}

export function getMaintenanceRepositoryUrl(prUrl: string): string | null {
  const match = /^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9._-]+)\/pull\/[1-9][0-9]*\/?$/i.exec(
    prUrl
  );
  return match?.[1] ? `https://github.com/${match[1].toLowerCase()}` : null;
}
