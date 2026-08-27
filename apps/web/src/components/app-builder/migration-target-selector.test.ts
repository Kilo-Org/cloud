import { describe, expect, it } from '@jest/globals';
import type { GitHubMigrationTarget } from '@/lib/app-builder/types';
import { getMigrationTargetLabel, resolveMigrationTarget } from './migration-target-selector';

function target(
  platformIntegrationId: string,
  platformAccountLogin: string,
  githubAppType: 'standard' | 'lite'
): GitHubMigrationTarget {
  return {
    platformIntegrationId,
    platformAccountLogin,
    githubAppType,
    newRepoUrl: `https://github.com/organizations/${platformAccountLogin}/repositories/new`,
    installationSettingsUrl: `https://github.com/settings/installations/${platformIntegrationId}`,
    availableRepos: [],
    repositorySelection: 'all',
  };
}

describe('App Builder migration target selection', () => {
  it('selects a secondary installation by integration identity', () => {
    const primary = target('integration-standard', 'acme-core', 'standard');
    const secondary = target('integration-lite', 'acme-apps', 'lite');

    expect(resolveMigrationTarget([primary, secondary], secondary)).toEqual({
      target: secondary,
      isUnavailable: false,
    });
  });

  it('keeps an unavailable pin instead of falling back to another installation', () => {
    const available = target('integration-standard', 'acme-core', 'standard');
    const unavailable = target('integration-lite', 'acme-apps', 'lite');

    expect(resolveMigrationTarget([available], unavailable)).toEqual({
      target: unavailable,
      isUnavailable: true,
    });
  });

  it('distinguishes duplicate account names by Standard and Lite app type', () => {
    const standard = target('integration-standard', 'acme', 'standard');
    const lite = target('integration-lite', 'acme', 'lite');

    expect(getMigrationTargetLabel(standard, [standard, lite])).toBe('acme (Standard app)');
    expect(getMigrationTargetLabel(lite, [standard, lite])).toBe('acme (Lite app)');
  });
});
