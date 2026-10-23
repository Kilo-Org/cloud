import { describe, expect, it } from 'vitest';

import {
  getCodeReviewerProfilePath,
  getProfileAgentScope,
  getProfileAgentsPath,
  getProfileCommandsPath,
  getProfileMcpPath,
  getProfileOverviewPath,
  getProfileSkillsPath,
  getProfileSlashCommandsPath,
  getProfilesPath,
  getProfileVariablesPath,
} from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';

const organizations = [{ organizationId: 'org-1' }, { organizationId: 'org-2' }];

describe('getProfileAgentScope', () => {
  it('uses personal when no organization is selected', () => {
    expect(getProfileAgentScope(null, organizations)).toBe('personal');
  });

  it('uses the selected organization when it is still available', () => {
    expect(getProfileAgentScope('org-2', organizations)).toBe('org-2');
  });

  it('keeps a stored organization the settled list no longer contains', () => {
    // A lost membership must reach the organization scope, which reports that
    // access is gone; substituting Personal opened its first-run setup instead.
    expect(getProfileAgentScope('removed-org', organizations)).toBe('removed-org');
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
    expect(getCodeReviewerProfilePath('personal')).toBe('/(app)/code-reviewer/personal');
    expect(getCodeReviewerProfilePath('org-1')).toBe('/(app)/code-reviewer/org-1');
    expect(getSecurityAgentPath('personal')).toBe('/(app)/security-agent/personal');
    expect(getSecurityAgentPath('org-1')).toBe('/(app)/security-agent/org-1');
  });
});

describe('Profile management paths', () => {
  it('builds the Manage Profiles entry path', () => {
    expect(getProfilesPath()).toBe('/(app)/(tabs)/(3_profile)/profiles');
  });

  it('builds each personal profile tab path', () => {
    expect(getProfileOverviewPath('profile-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1'
    );
    expect(getProfileVariablesPath('profile-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/variables'
    );
    expect(getProfileCommandsPath('profile-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/commands'
    );
    expect(getProfileSlashCommandsPath('profile-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/slash-commands'
    );
    expect(getProfileMcpPath('profile-1')).toBe('/(app)/(tabs)/(3_profile)/profiles/profile-1/mcp');
    expect(getProfileAgentsPath('profile-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/agents'
    );
    expect(getProfileSkillsPath('profile-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/skills'
    );
  });

  it('carries the organization id on each organization profile tab path', () => {
    expect(getProfileOverviewPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1?organizationId=org-1'
    );
    expect(getProfileVariablesPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/variables?organizationId=org-1'
    );
    expect(getProfileCommandsPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/commands?organizationId=org-1'
    );
    expect(getProfileSlashCommandsPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/slash-commands?organizationId=org-1'
    );
    expect(getProfileMcpPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/mcp?organizationId=org-1'
    );
    expect(getProfileAgentsPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/agents?organizationId=org-1'
    );
    expect(getProfileSkillsPath('profile-1', 'org-1')).toBe(
      '/(app)/(tabs)/(3_profile)/profiles/profile-1/skills?organizationId=org-1'
    );
  });
});
