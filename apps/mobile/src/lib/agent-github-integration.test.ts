import { describe, expect, it } from 'vitest';

import {
  getGitHubIntegrationUrl,
  shouldShowGitHubIntegrationPrompt,
} from './agent-github-integration';

describe('agent GitHub integration helpers', () => {
  it('shows the setup prompt only after GitHub is known to be disconnected', () => {
    expect(
      shouldShowGitHubIntegrationPrompt({
        isLoadingRepos: false,
        integrationInstalled: false,
      })
    ).toBe(true);

    expect(
      shouldShowGitHubIntegrationPrompt({
        isLoadingRepos: true,
        integrationInstalled: false,
      })
    ).toBe(false);

    expect(
      shouldShowGitHubIntegrationPrompt({
        isLoadingRepos: false,
        integrationInstalled: true,
      })
    ).toBe(false);
  });

  it('builds personal and organization GitHub integration URLs', () => {
    expect(getGitHubIntegrationUrl('https://app.kilo.ai')).toBe('https://app.kilo.ai/github-app');
    expect(getGitHubIntegrationUrl('https://app.kilo.ai/', 'org_123')).toBe(
      'https://app.kilo.ai/github-app?organizationId=org_123'
    );
  });
});
