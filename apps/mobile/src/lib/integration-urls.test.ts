import { describe, expect, it } from 'vitest';

import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from './integration-urls';

describe('getGitLabIntegrationUrl', () => {
  it('builds personal and organization GitLab integration URLs', () => {
    expect(getGitLabIntegrationUrl('https://app.kilo.ai')).toBe(
      'https://app.kilo.ai/integrations/gitlab'
    );
    expect(getGitLabIntegrationUrl('https://app.kilo.ai/', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/integrations/gitlab'
    );
  });
});

describe('getBitbucketIntegrationUrl', () => {
  it('links to the org code-reviews page with the Bitbucket tab selected', () => {
    expect(getBitbucketIntegrationUrl('https://app.kilo.ai', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/code-reviews?platform=bitbucket'
    );
    expect(getBitbucketIntegrationUrl('https://app.kilo.ai/', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/code-reviews?platform=bitbucket'
    );
  });
});
