import { describe, expect, it } from 'vitest';

import { getCodeReviewerProfilePath, getProfileAgentScope } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';

const organizations = [{ organizationId: 'org-1' }, { organizationId: 'org-2' }];

describe('getProfileAgentScope', () => {
  it('uses personal when no organization is selected', () => {
    expect(getProfileAgentScope(null, organizations)).toBe('personal');
  });

  it('uses the selected organization when it is still available', () => {
    expect(getProfileAgentScope('org-2', organizations)).toBe('org-2');
  });

  it('falls back to personal when the stored organization is unavailable', () => {
    expect(getProfileAgentScope('removed-org', organizations)).toBe('personal');
  });

  it('waits until organizations have loaded before resolving a selected organization', () => {
    expect(getProfileAgentScope('org-1', undefined)).toBeUndefined();
  });

  it('waits while organizations are being refreshed before resolving a selected organization', () => {
    expect(getProfileAgentScope('org-1', organizations, true)).toBeUndefined();
  });
});

describe('Profile agent paths', () => {
  it('builds direct Code Reviewer and Security Agent routes for a scope', () => {
    expect(getCodeReviewerProfilePath('personal')).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/personal'
    );
    expect(getCodeReviewerProfilePath('org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/code-reviewer/org-1'
    );
    expect(getSecurityAgentPath('personal')).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/personal'
    );
    expect(getSecurityAgentPath('org-1')).toBe('/(app)/(tabs)/(3_profile)/security-agent/org-1');
  });
});
