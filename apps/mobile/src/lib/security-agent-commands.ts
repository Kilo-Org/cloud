import { type SecurityCommand } from '@/lib/security-agent';

type SecurityCommandType = 'sync' | 'dismiss_finding' | 'start_analysis' | 'apply_auto_remediation';

export type SecurityQueryScope =
  | 'findings'
  | 'findingDetails'
  | 'analysis'
  | 'stats'
  | 'dashboardStats'
  | 'lastSyncTime'
  | 'repositories'
  | 'permissionStatus';

// Ported from apps/web/src/components/security-agent/security-agent-command-invalidation.ts:19.
// Mobile has no orphaned-repository cleanup or auto-dismiss surfaces, so those two
// web-only scopes are dropped from every list below.
const syncScopes = [
  'findings',
  'findingDetails',
  'analysis',
  'stats',
  'dashboardStats',
  'lastSyncTime',
  'repositories',
  'permissionStatus',
] as const satisfies readonly SecurityQueryScope[];

const dismissalScopes = [
  'findings',
  'findingDetails',
  'stats',
  'dashboardStats',
] as const satisfies readonly SecurityQueryScope[];

const analysisScopes = [
  'findings',
  'findingDetails',
  'analysis',
  'stats',
  'dashboardStats',
] as const satisfies readonly SecurityQueryScope[];

const remediationScopes = [
  'findings',
  'findingDetails',
  'analysis',
  'stats',
  'dashboardStats',
] as const satisfies readonly SecurityQueryScope[];

export function securityCommandIdsKey(scope: string) {
  return ['security-agent-command-ids', scope] as const;
}

export function isActiveSecurityCommand(command: SecurityCommand): boolean {
  return command.status === 'accepted' || command.status === 'running';
}

export function mergeTrackedCommandIds(
  recovered: readonly string[],
  tracked: readonly string[]
): string[] {
  return [...new Set([...recovered, ...tracked])];
}

const scopesByCommandType: Record<SecurityCommandType, readonly SecurityQueryScope[]> = {
  sync: syncScopes,
  dismiss_finding: dismissalScopes,
  start_analysis: analysisScopes,
  apply_auto_remediation: remediationScopes,
};

export function getSecurityCommandInvalidationScopes(
  commandType: SecurityCommandType
): readonly SecurityQueryScope[] {
  return scopesByCommandType[commandType];
}

// Ported from apps/web/src/components/security-agent/SecurityAgentContext.tsx:362
// (commandFailureDescription) — the user-visible fallback copy per result code.
// Result codes with a fixed message (independent of `lastErrorRedacted`).
const FAILURE_MESSAGE_BY_RESULT_CODE: Record<string, string> = {
  OWNER_CAP_REACHED:
    'Analysis capacity is full. Wait for an active analysis to finish, then retry.',
  GITHUB_TOKEN_UNAVAILABLE:
    'GitHub authorization needs attention. Re-authorize GitHub App, then retry.',
  GITHUB_AUTH_INVALID: 'GitHub authorization needs attention. Re-authorize GitHub App, then retry.',
  FINDING_UNAVAILABLE:
    'Finding is no longer available. Refresh findings and retry if it remains open.',
  REPOSITORY_UNAVAILABLE:
    'Repository is no longer available to GitHub App. Refresh repository access, then retry.',
  INVALID_DISMISS_TARGET: 'Finding cannot be dismissed because its Dependabot target is invalid.',
  COMMAND_STALLED: 'Queued action did not finish in time. Retry action.',
  // The backend stores a raw "…maximum delivery attempts" string in
  // lastErrorRedacted for this code; surface friendly, actionable copy instead.
  QUEUE_RETRIES_EXHAUSTED: 'Action could not be completed after several attempts. Retry action.',
};

export function getSecurityCommandFailureMessage(command: SecurityCommand): string {
  const knownMessage = command.resultCode
    ? FAILURE_MESSAGE_BY_RESULT_CODE[command.resultCode]
    : undefined;
  if (knownMessage) {
    return knownMessage;
  }
  if (command.resultCode === 'QUEUE_ADMISSION_FAILED') {
    return command.lastErrorRedacted ?? 'Queued action could not be admitted. Retry action.';
  }
  return command.lastErrorRedacted ?? 'Queued action failed. Retry action.';
}
