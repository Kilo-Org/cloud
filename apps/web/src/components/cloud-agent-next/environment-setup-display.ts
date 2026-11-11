import { isResumableSetupRunStatus } from '@kilocode/cloud-agent-profile';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import type { SetupRunDiff, SetupRunDiffEgress } from '@/lib/cloud-agent/environment-setup/diff';

export const environmentSetupStatusLabels = {
  starting: 'Starting',
  running: 'Working',
  needs_input: 'Needs your input',
  verifying: 'Testing',
  publish_conflict: 'Needs a decision',
  failed: 'Stopped',
  published: 'Published',
  reverted: 'Reverted',
  cancelled: 'Cancelled',
} satisfies Record<SetupRunResponse['status'], string>;

export function canContinueEnvironmentSetup(
  run: Pick<SetupRunResponse, 'status' | 'agentState' | 'draftEnvironmentId'>
): boolean {
  return (
    run.draftEnvironmentId !== null &&
    isResumableSetupRunStatus(run.status) &&
    (run.status === 'failed' ||
      run.agentState?.kind === 'stopped' ||
      run.agentState?.kind === 'idle')
  );
}

function keyChanges(added: string[], removed: string[], changed: string[] = []) {
  return [
    ...added.map(key => `+${key}`),
    ...removed.map(key => `−${key}`),
    ...changed.map(key => `~${key}`),
  ].join(', ');
}

function networkLabel(egress: SetupRunDiffEgress) {
  return egress.mode === 'unrestricted'
    ? 'Full'
    : egress.allowlist.length
      ? `Limited (${egress.allowlist.join(', ')})`
      : 'None';
}

export function formatEnvironmentSetupDiff(diff: SetupRunDiff): string[] {
  const lines: string[] = [];
  if (diff.scriptChanged) lines.push('Setup script changed');
  const variables = keyChanges(diff.plainVarsAdded, diff.plainVarsRemoved, diff.plainVarsChanged);
  if (variables) lines.push(`Variables: ${variables}`);
  const secrets = keyChanges(diff.secretKeysAdded, diff.secretKeysRemoved);
  if (secrets) lines.push(`Secrets: ${secrets}`);
  if (diff.sandboxAllocation)
    lines.push(
      `Sandbox: ${diff.sandboxAllocation.before ?? 'Default'} → ${diff.sandboxAllocation.after ?? 'Default'}`
    );
  if (diff.egress)
    lines.push(`Network: ${networkLabel(diff.egress.before)} → ${networkLabel(diff.egress.after)}`);
  const hosts = keyChanges(diff.requiredHostsAdded, diff.requiredHostsRemoved);
  if (hosts) lines.push(`Required hosts: ${hosts}`);
  const repositories = keyChanges(diff.repositoriesAdded, diff.repositoriesRemoved);
  if (repositories) lines.push(`Repositories: ${repositories}`);
  return lines;
}

export function setupTestChatId(run: SetupRunResponse, childSessionId: string): string | null {
  if (run.cloudAgentSessionId === childSessionId) return run.kiloSessionId;
  if (run.pendingVerification?.childSessionId === childSessionId)
    return run.pendingVerification.childKiloSessionId;
  if (run.lastVerification?.childSessionId === childSessionId)
    return run.lastVerification.childKiloSessionId;
  return null;
}

export function formatSetupDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
