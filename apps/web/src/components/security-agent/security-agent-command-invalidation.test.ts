import { describe, expect, it } from '@jest/globals';
import { getSecurityAgentInvalidationScopesForCommand } from './security-agent-command-invalidation';

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

  it('keeps analysis terminals scoped to finding analysis views', () => {
    const scopes = getSecurityAgentInvalidationScopesForCommand('start_analysis');

    expect(scopes).toEqual(expect.arrayContaining(['findings', 'analysis']));
    expect(scopes).not.toContain('repositories');
    expect(scopes).not.toContain('permissionStatus');
  });
});
