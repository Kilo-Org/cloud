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
  waiting_for_session: 'Waiting for your session to finish',
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
    return 'Maintenance waits for your running chats and the workspace quiet period. No repair chat exists until it can start.';
  }
  // The `maintenance_question` recovery message already names the chat action,
  // so this line adds guidance only when no chat can answer the question.
  if (watch.execution_status === 'needs_input' && !watch.activeChat?.chatAvailable) {
    return 'Resolve the reported blocker, then recheck the PR. No maintenance chat needs an answer.';
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
  user_pause: 'You paused maintenance. Resume when you want automatic work to continue.',
  ready_to_resume:
    'Readiness checks passed. Maintenance remains paused. Select Resume when you are ready.',
  user_stop: 'You stopped maintenance. Enable it again to assess the PR and continue.',
  expired: 'The observation watch expired. Enable maintenance with new consent to continue.',
  maintenance_chat_stopped:
    'You stopped the maintenance chat. Resume maintenance when you are ready.',
  user_session_active:
    'Maintenance waits for your chats and the workspace quiet period. Your chats can continue.',
  conflict_state_unknown:
    'GitHub could not determine merge conflicts. Inspect the PR, then recheck.',
  delivery_attempt_limit:
    'Maintenance could not start after its delivery retries. Check workspace access, then resume maintenance.',
  problem_attempt_limit:
    'A problem reached its attempt limit. Review its maintenance chat and resolve the blocker.',
  publication_unverified:
    'The push result is not verified. Inspect the remote branch and maintenance chat, verify the result, then Recheck.',
  maintenance_attempt_timeout:
    'The maintenance attempt exceeded its time limit. Inspect its chat and workspace before you resume.',
  total_attempt_limit:
    'The total attempt limit was reached. Inspect the maintenance chats and repair the PR manually, or stop maintenance.',
  source_worktree_deleted:
    'The workspace is unavailable. Maintenance cannot continue in this workspace.',
  pr_closed: 'The PR is closed. Maintenance has finished.',
  pr_merged: 'The PR is merged. Maintenance has finished.',
  maintenance_question:
    'Open the current maintenance chat and answer its question. Your answer continues the same chat.',
  maintenance_workspace_settings_changed:
    'Workspace settings or the selected model changed. Stop maintenance, then enable it with current settings and new consent.',
  maintenance_pr_identity_changed:
    'The linked PR or branch changed. Stop maintenance, verify the workspace PR, then enable maintenance with new consent.',
  maintenance_purpose_unavailable:
    'Restore a clear workspace task and PR description, then Recheck. If the source task cannot be restored, stop maintenance and use a chat with a clear task.',
  maintenance_parent_commit_unavailable:
    'Restore the stacked workspace parent commit, then Recheck. If it is unavailable, stop maintenance and repair the workspace manually.',
  maintenance_access_unavailable:
    'Restore repository access and the GitHub connection, then Recheck.',
  maintenance_balance_unavailable:
    'Maintenance needs at least $1 in credits for this model. Add credits, then Recheck. To change models, stop and enable maintenance with new consent.',
  maintenance_precondition_changed:
    'Workspace or PR requirements changed. Correct the reported change, then Recheck.',
  pr_assessment_unavailable:
    'GitHub PR assessment is unavailable. Check the connection and PR access, then Recheck.',
  pr_observation_incomplete:
    'GitHub feedback is incomplete. Check PR access and wait for GitHub to recover, then Recheck.',
  maintenance_verification_failed:
    'Maintenance verification failed. Inspect the chat, repair the failure, then Recheck.',
  maintenance_verification_unavailable:
    'Maintenance could not verify its changes. Inspect the chat and verify the changes manually, then Recheck.',
  maintenance_result_unavailable_after_publication:
    'Git publication was observed, but the updated repair result is missing. Inspect the remote branch and chat, correct the issue, then Stop and enable maintenance with new consent.',
  maintenance_result_unavailable_after_answer:
    'Your answer completed, but maintenance did not return an updated repair result. Inspect the chat, correct the issue, then Stop and enable maintenance with new consent.',
  maintenance_github_action_blocked:
    'A GitHub reply or thread update is blocked. Inspect the PR and GitHub access before rechecking.',
  maintenance_runtime_state_unavailable:
    'The maintenance chat state is unavailable. Check the workspace and chat, then Recheck.',
  missing_stable_session_identity:
    'The maintenance chat identity is incomplete. Inspect the workspace and contact support before starting another repair.',
  reviewer_approval_required:
    'The PR needs a human review decision. Open the GitHub review and request the required approval. Other maintenance can continue.',
  waiting_for_clean_checkout:
    'Maintenance waits for a clean checkout and the workspace quiet period. Keep unrelated changes safe; do not discard them.',
  remote_head_changed_reassessing:
    'The remote branch changed. Maintenance will fetch and reassess it before another bounded attempt.',
  rate_limited:
    'GitHub delayed maintenance because of its rate limit. Maintenance waits until the reset time.',
  low_budget: 'Maintenance waits for available GitHub API budget. It remains enabled.',
  throttled: 'Maintenance waits before the next GitHub refresh.',
  write_pacing: 'Maintenance waits before the next GitHub reply or thread update.',
  unavailable: 'GitHub is temporarily unavailable. Maintenance will retry within its limits.',
  maintenance_session_active:
    'Another maintenance chat is active in this workspace. Maintenance waits for that attempt to finish.',
  pr_assessment_retry:
    'PR assessment will retry within its limits. No repair starts from missing evidence.',
  maintenance_delivery_retry:
    'The maintenance chat request will retry with the same identity. No duplicate repair is requested.',
  conflict_state_pending:
    'GitHub is still checking merge conflicts. Maintenance waits for the bounded follow-up check.',
};

export function getMaintenanceRecoveryMessage(reason: string | null): string | null {
  if (!reason) return null;
  return Object.prototype.hasOwnProperty.call(recoveryMessages, reason)
    ? recoveryMessages[reason as keyof typeof recoveryMessages]
    : `${reason.replaceAll('_', ' ')}. Inspect the maintenance chat and PR before rechecking.`;
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
