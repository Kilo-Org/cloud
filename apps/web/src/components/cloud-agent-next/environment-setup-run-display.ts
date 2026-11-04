import type {
  EnvironmentSetupRunStatus,
  EnvironmentSetupVerification,
} from '@kilocode/cloud-agent-profile';
import type { SetupRunDiff, SetupRunDiffEgress } from '@/lib/cloud-agent/environment-setup/diff';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { formatDuration } from './environment-build-display';

export type SetupRunBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'new';

export type SetupRunBadge = {
  text: string;
  variant: SetupRunBadgeVariant;
};

export function setupRunBadge(status: EnvironmentSetupRunStatus): SetupRunBadge {
  switch (status) {
    case 'starting':
    case 'running':
      return { text: 'Working', variant: 'secondary' };
    case 'needs_input':
      return { text: 'Needs your input', variant: 'default' };
    case 'verifying':
      return { text: 'Testing', variant: 'secondary' };
    case 'waiting_for_merge':
      return { text: 'Waiting for pull request', variant: 'secondary' };
    case 'publish_conflict':
      return { text: 'Needs a decision', variant: 'destructive' };
    case 'failed':
      return { text: 'Stopped', variant: 'destructive' };
    case 'published':
      return { text: 'Published', variant: 'new' };
    case 'reverted':
      return { text: 'Reverted', variant: 'outline' };
    case 'cancelled':
      return { text: 'Cancelled', variant: 'outline' };
  }
}

export type SetupRunChange =
  | { kind: 'script'; before: string; after: string }
  | { kind: 'text'; text: string };

function signedList(added: string[], removed: string[], changed: string[] = []): string {
  return [
    ...added.map(value => `+${value}`),
    ...removed.map(value => `−${value}`),
    ...changed.map(value => `~${value}`),
  ].join(', ');
}

function missingFrom(retained: string[], candidates: string[]): string[] {
  const values = new Set(retained);
  return candidates.filter(value => !values.has(value));
}

function addedTo(before: string[], after: string[]): string[] {
  return missingFrom(before, after);
}

function allocationLabel(allocation: string | null): string {
  return allocation ?? 'default';
}

function egressLabel(egress: SetupRunDiffEgress): string {
  return egress.mode === 'allowlist' ? 'allowlist' : 'full';
}

function egressChange(before: SetupRunDiffEgress, after: SetupRunDiffEgress): string {
  if (before.mode !== after.mode) {
    return `Network: ${egressLabel(before)} → ${egressLabel(after)}`;
  }
  return `Network: ${signedList(
    addedTo(before.allowlist, after.allowlist),
    missingFrom(after.allowlist, before.allowlist)
  )}`;
}

export function setupRunChanges(diff: SetupRunDiff): SetupRunChange[] {
  const changes: SetupRunChange[] = [];

  if (diff.scriptChanged) {
    changes.push({ kind: 'script', before: diff.scriptBefore, after: diff.scriptAfter });
  }

  const variables = signedList(diff.plainVarsAdded, diff.plainVarsRemoved, diff.plainVarsChanged);
  if (variables !== '') {
    changes.push({ kind: 'text', text: `Variables: ${variables}` });
  }

  const secrets = signedList(diff.secretKeysAdded, diff.secretKeysRemoved);
  if (secrets !== '') {
    changes.push({ kind: 'text', text: `Secrets: ${secrets}` });
  }

  if (diff.sandboxAllocation !== null) {
    changes.push({
      kind: 'text',
      text: `Sandbox: ${allocationLabel(diff.sandboxAllocation.before)} → ${allocationLabel(
        diff.sandboxAllocation.after
      )}`,
    });
  }

  if (diff.egress !== null) {
    changes.push({ kind: 'text', text: egressChange(diff.egress.before, diff.egress.after) });
  }

  const requiredHosts = signedList(diff.requiredHostsAdded, diff.requiredHostsRemoved);
  if (requiredHosts !== '') {
    changes.push({ kind: 'text', text: `Required hosts: ${requiredHosts}` });
  }

  return changes;
}

export function setupRunVerificationSummary(verification: EnvironmentSetupVerification): string {
  if (verification.preparation === 'failed') {
    return `Setup failed: ${
      verification.preparationError ?? 'the test sandbox could not be prepared.'
    }`;
  }
  if (verification.preparation === 'missing') {
    return 'Setup failed: the test session was not found.';
  }
  if (verification.preparation === 'running') {
    return 'Setup is still running.';
  }
  if (verification.setupDurationMs === null) {
    return 'Setup passed';
  }
  return `Setup passed in ${formatDuration(verification.setupDurationMs)}`;
}

const STATUS_REASON_COPY: Record<string, string> = {
  session_start_failed: 'The setup session could not start.',
  agent_failed: 'The setup agent failed.',
  verification_limit_reached: 'The setup reached its test limit.',
  setup_pr_closed: 'The setup pull request was closed without merging.',
  setup_pr_changed: 'The setup pull request changed after testing.',
  publish_validation_failed: 'The setup could not be published.',
  draft_deleted: 'The draft environment was deleted.',
  abandoned: 'The setup was abandoned.',
};

const AGENT_STOP_COPY: Record<string, string> = {
  no_progress: 'it made no progress',
  execution_limit: 'it reached its time limit',
  agent_unresponsive: 'Kilo stopped responding',
  agent_restarted: 'Kilo restarted',
  interrupted: 'you stopped it',
  failed: 'it failed',
};

export function setupRunStopNotice(
  run: Pick<
    SetupRunResponse,
    'status' | 'statusReason' | 'statusDetail' | 'agentState' | 'cloudAgentSessionId'
  >
): string | null {
  if (run.status === 'failed') {
    return (
      run.statusDetail ??
      (run.statusReason === null ? null : STATUS_REASON_COPY[run.statusReason]) ??
      'The setup stopped.'
    );
  }
  if (run.status === 'running' && run.agentState?.kind === 'stopped') {
    const copy = AGENT_STOP_COPY[run.agentState.reason];
    return copy === undefined ? 'The setup stopped.' : `The agent stopped: ${copy}.`;
  }
  return null;
}

export type SetupRunAction =
  | 'revert'
  | 'buildSnapshot'
  | 'publishAnyway'
  | 'discard'
  | 'publishNow'
  | 'cancel';

export function setupRunActions(
  run: Pick<SetupRunResponse, 'status' | 'canRevert' | 'targetEnvironmentId'>,
  options: { canManage: boolean; hasStoppedSection: boolean }
): SetupRunAction[] {
  if (!options.canManage || options.hasStoppedSection) return [];
  switch (run.status) {
    case 'published': {
      const actions: SetupRunAction[] = [];
      if (run.canRevert) actions.push('revert');
      actions.push('buildSnapshot');
      return actions;
    }
    case 'publish_conflict':
      return ['publishAnyway', 'discard'];
    case 'waiting_for_merge':
      return ['publishNow', 'cancel'];
    case 'starting':
    case 'running':
    case 'needs_input':
    case 'verifying':
    case 'failed':
      return ['cancel'];
    default:
      return [];
  }
}

export function setupRunNetworkLabel(mode: 'unrestricted' | 'allowlist' | null): string | null {
  if (mode === null) {
    return null;
  }
  return mode === 'allowlist' ? 'allowlist' : 'full';
}
