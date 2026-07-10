import {
  getSecurityCommandInvalidationScopes,
  type SecurityQueryScope,
} from '@kilocode/app-shared/security-agent';

// SecurityCommandType isn't exported from the shared package (it's an
// internal detail of getSecurityCommandInvalidationScopes' parameter), so
// the literal union is kept here — same values as the shared module.
export type SecurityAgentCommandType =
  | 'sync'
  | 'dismiss_finding'
  | 'start_analysis'
  | 'apply_auto_remediation';
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
