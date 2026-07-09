import { type inferRouterInputs, type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { type Href } from 'expo-router';

type RouterInputs = inferRouterInputs<RootRouter>;
type RouterOutputs = inferRouterOutputs<RootRouter>;

export const PERSONAL_SECURITY_SCOPE = 'personal';
export type SecurityAgentConfig = RouterOutputs['securityAgent']['getConfig'];
export type SecurityAgentConfigPatch = RouterInputs['securityAgent']['saveConfig'];
export type SecurityFinding = RouterOutputs['securityAgent']['getFinding'];
export type SecurityAnalysis = RouterOutputs['securityAgent']['getAnalysis'];
export type SecurityCommand = NonNullable<RouterOutputs['securityAgent']['getCommandStatus']>;
export type OrganizationRole = 'owner' | 'billing_manager' | 'member';

export function isPersonalSecurityScope(scope: string): boolean {
  return scope === PERSONAL_SECURITY_SCOPE;
}

export function canManageSecurityAgent(scope: string, role: OrganizationRole | undefined): boolean {
  return isPersonalSecurityScope(scope) || role === 'owner' || role === 'billing_manager';
}

export function getSecurityAgentPath(scope: string, suffix = ''): Href {
  const path = `/(app)/(tabs)/(3_profile)/security-agent/${scope}`;
  return (suffix ? `${path}/${suffix}` : path) as Href;
}

export function getSecurityAgentAuditUrl(webBaseUrl: string, scope: string): string {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  return isPersonalSecurityScope(scope)
    ? `${base}/security-agent/audit-report`
    : `${base}/organizations/${encodeURIComponent(scope)}/security-agent/audit-report`;
}

export function isSecurityConfigPatchDirty(
  config: Partial<SecurityAgentConfig>,
  patch: SecurityAgentConfigPatch
): boolean {
  return Object.entries(patch).some(([key, next]) => {
    const current = config[key as keyof SecurityAgentConfig];
    if (Array.isArray(next) && Array.isArray(current)) {
      return next.length !== current.length || next.some(value => !current.includes(value));
    }
    return !Object.is(next, current);
  });
}

type SecurityRepository = { id: number };

export function getSecurityRepositoriesInScope<T extends SecurityRepository>(
  repositories: readonly T[],
  config: Pick<SecurityAgentConfig, 'repositorySelectionMode' | 'selectedRepositoryIds'> | undefined
): T[] {
  if (!config || config.repositorySelectionMode === 'all') {
    return [...repositories];
  }
  const selectedIds = new Set(config.selectedRepositoryIds);
  return repositories.filter(repository => selectedIds.has(repository.id));
}
