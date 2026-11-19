export const SECURITY_COMMAND_TYPES = [
  'sync',
  'dismiss_finding',
  'start_analysis',
  'apply_auto_remediation',
] as const;
export type SecurityCommandType = (typeof SECURITY_COMMAND_TYPES)[number];

// Web's full invalidation-scope superset (from
// apps/web/src/components/security-agent/security-agent-command-invalidation.ts:6).
// Mobile filters this down to the scopes it implements when it adopts this
// module — it has no orphaned-repository cleanup, auto-dismiss, or config
// surfaces yet, but the shared table stays authoritative for both.
export type SecurityQueryScope =
  | 'findings'
  | 'findingDetails'
  | 'analysis'
  | 'stats'
  | 'dashboardStats'
  | 'lastSyncTime'
  | 'repositories'
  | 'orphanedRepositories'
  | 'autoDismissEligible'
  | 'permissionStatus'
  | 'config';

// Ported from apps/web/src/components/security-agent/security-agent-command-invalidation.ts:19.
const syncScopes = [
  'findings',
  'findingDetails',
  'analysis',
  'stats',
  'dashboardStats',
  'lastSyncTime',
  'repositories',
  'orphanedRepositories',
  'autoDismissEligible',
  'permissionStatus',
] as const satisfies readonly SecurityQueryScope[];

const dismissalScopes = [
  'findings',
  'findingDetails',
  'stats',
  'dashboardStats',
  'autoDismissEligible',
] as const satisfies readonly SecurityQueryScope[];

const analysisScopes = [
  'findings',
  'findingDetails',
  'analysis',
  'stats',
  'dashboardStats',
  'autoDismissEligible',
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

// Structural shape of a security command — only the fields these helpers
// read, kept permissive so both web's and mobile's command types satisfy it.
export type SecurityCommand = {
  status: string;
  resultCode?: string | null;
  lastErrorRedacted?: string | null;
};

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
// (commandFailureDescription) — the user-visible failure copy per result code,
// and the fixed copy for every code this table does not name. The backend
// detail (`lastErrorRedacted`) stays diagnostics-only: it can carry raw
// backend wording (for QUEUE_ADMISSION_FAILED it stores a
// "…maximum delivery attempts" string), so it is never the text this slot
// shows. Surfaces that render the detail separately keep reading it from the
// command object itself.
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
  QUEUE_RETRIES_EXHAUSTED: 'Action could not be completed after several attempts. Retry action.',
  QUEUE_ADMISSION_FAILED: 'Queued action could not be admitted. Retry action.',
};

export function getSecurityCommandFailureMessage(command: SecurityCommand): string {
  const knownMessage = command.resultCode
    ? FAILURE_MESSAGE_BY_RESULT_CODE[command.resultCode]
    : undefined;
  return knownMessage ?? 'Queued action failed. Retry action.';
}
