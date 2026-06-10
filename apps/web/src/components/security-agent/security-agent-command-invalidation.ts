export type SecurityAgentCommandType = 'sync' | 'dismiss_finding' | 'start_analysis';
export type SecurityAgentInvalidationScope =
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
] as const satisfies readonly SecurityAgentInvalidationScope[];

const dismissalScopes = [
  'findings',
  'findingDetails',
  'stats',
  'dashboardStats',
  'autoDismissEligible',
] as const satisfies readonly SecurityAgentInvalidationScope[];

const analysisScopes = [
  'findings',
  'findingDetails',
  'analysis',
  'stats',
  'dashboardStats',
  'autoDismissEligible',
] as const satisfies readonly SecurityAgentInvalidationScope[];

export const deletedSecurityAgentFindingsScopes = [
  'findings',
  'findingDetails',
  'stats',
  'dashboardStats',
  'orphanedRepositories',
  'autoDismissEligible',
] as const satisfies readonly SecurityAgentInvalidationScope[];

export function getSecurityAgentInvalidationScopesForCommand(
  commandType: SecurityAgentCommandType
): readonly SecurityAgentInvalidationScope[] {
  switch (commandType) {
    case 'sync':
      return syncScopes;
    case 'dismiss_finding':
      return dismissalScopes;
    case 'start_analysis':
      return analysisScopes;
  }
}
