import { describe, expect, it } from '@jest/globals';
import {
  deletedSecurityAgentFindingsScopes,
  getSecurityAgentInvalidationScopesForCommand,
} from './security-agent-command-invalidation';

describe('getSecurityAgentInvalidationScopesForCommand', () => {
  it('refreshes permission and freshness data after sync terminals', () => {
    expect(getSecurityAgentInvalidationScopesForCommand('sync')).toEqual(
      expect.arrayContaining(['lastSyncTime', 'repositories', 'permissionStatus'])
    );
  });

  it('keeps dismissal terminals scoped to finding-derived views', () => {
    const scopes = getSecurityAgentInvalidationScopesForCommand('dismiss_finding');

    expect(scopes).toEqual(expect.arrayContaining(['findings', 'stats', 'dashboardStats']));
    expect(scopes).not.toContain('lastSyncTime');
    expect(scopes).not.toContain('repositories');
    expect(scopes).not.toContain('permissionStatus');
  });

  it('keeps analysis terminals scoped to finding analysis and eligibility views', () => {
    const scopes = getSecurityAgentInvalidationScopesForCommand('start_analysis');

    expect(scopes).toEqual(expect.arrayContaining(['findings', 'analysis', 'autoDismissEligible']));
    expect(scopes).not.toContain('repositories');
    expect(scopes).not.toContain('permissionStatus');
  });

  it('refreshes cached finding details after bulk delete', () => {
    expect(deletedSecurityAgentFindingsScopes).toEqual(
      expect.arrayContaining(['findings', 'findingDetails', 'orphanedRepositories'])
    );
  });
});
