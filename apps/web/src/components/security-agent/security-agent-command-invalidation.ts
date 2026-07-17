import {
  getSecurityCommandInvalidationScopes,
  type SecurityCommandType,
  type SecurityQueryScope,
} from '@kilocode/app-shared/security-agent';

export type SecurityAgentCommandType = SecurityCommandType;
export type SecurityAgentInvalidationScope = SecurityQueryScope;

// Not part of the shared scope table (web-only bulk-delete flow; mobile has
// no orphaned-repository cleanup surface yet).
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
  return getSecurityCommandInvalidationScopes(commandType);
}
