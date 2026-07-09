import { describe, expect, it } from 'vitest';

import {
  canManageSecurityAgent,
  getSecurityAgentAuditUrl,
  getSecurityAgentPath,
  getSecurityRepositoriesInScope,
  isSecurityConfigPatchDirty,
  PERSONAL_SECURITY_SCOPE,
  type SecurityAgentConfig,
} from '@/lib/security-agent';

describe('Security Agent helpers', () => {
  it('builds personal and organization routes', () => {
    expect(getSecurityAgentPath(PERSONAL_SECURITY_SCOPE, 'findings')).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/personal/findings'
    );
    expect(getSecurityAgentPath('org_123', 'settings/automation')).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/org_123/settings/automation'
    );
  });

  it('builds owner-aware web audit URLs', () => {
    expect(getSecurityAgentAuditUrl('https://app.kilo.ai/', 'personal')).toBe(
      'https://app.kilo.ai/security-agent/audit-report'
    );
    expect(getSecurityAgentAuditUrl('https://app.kilo.ai', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/security-agent/audit-report'
    );
  });

  it('allows only personal, owner, and billing manager policy changes', () => {
    expect(canManageSecurityAgent('personal', undefined)).toBe(true);
    expect(canManageSecurityAgent('org_123', 'owner')).toBe(true);
    expect(canManageSecurityAgent('org_123', 'billing_manager')).toBe(true);
    expect(canManageSecurityAgent('org_123', 'member')).toBe(false);
  });

  it('compares scalar and repository-array patches', () => {
    const config = {
      analysisMode: 'auto',
      selectedRepositoryIds: [1, 2],
    } satisfies Partial<SecurityAgentConfig>;
    expect(isSecurityConfigPatchDirty(config, { analysisMode: 'auto' })).toBe(false);
    expect(isSecurityConfigPatchDirty(config, { analysisMode: 'deep' })).toBe(true);
    expect(isSecurityConfigPatchDirty(config, { selectedRepositoryIds: [1, 2] })).toBe(false);
    expect(isSecurityConfigPatchDirty(config, { selectedRepositoryIds: [2, 1] })).toBe(false);
    expect(isSecurityConfigPatchDirty(config, { selectedRepositoryIds: [1, 3] })).toBe(true);
  });

  it('limits repository choices to configured Security Agent scope', () => {
    const repositories = [
      { id: 1, fullName: 'kilo/one' },
      { id: 2, fullName: 'kilo/two' },
    ];
    expect(
      getSecurityRepositoriesInScope(repositories, {
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: [2],
      })
    ).toEqual([{ id: 2, fullName: 'kilo/two' }]);
    expect(
      getSecurityRepositoriesInScope(repositories, {
        repositorySelectionMode: 'all',
        selectedRepositoryIds: [],
      })
    ).toEqual(repositories);
  });
});
