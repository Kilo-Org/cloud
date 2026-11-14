import { describe, expect, it } from 'vitest';

import {
  getBitbucketIntegrationUrl,
  getByokUrl,
  getGitLabIntegrationUrl,
  getIntegrationPagePath,
  getIntegrationPageUrl,
} from './integration-urls';

describe('getIntegrationPagePath', () => {
  it('builds the personal and organization paths the web pages live at', () => {
    expect(getIntegrationPagePath('slack')).toBe('/integrations/slack');
    expect(getIntegrationPagePath('linear', 'org_123')).toBe(
      '/organizations/org_123/integrations/linear'
    );
  });

  it('encodes the organization id', () => {
    expect(getIntegrationPagePath('github', 'org/123')).toBe(
      '/organizations/org%2F123/integrations/github'
    );
  });
});

describe('getIntegrationPageUrl', () => {
  it('joins the web base URL without doubling the slash', () => {
    expect(getIntegrationPageUrl('https://app.kilo.ai', 'discord')).toBe(
      'https://app.kilo.ai/integrations/discord'
    );
    expect(getIntegrationPageUrl('https://app.kilo.ai/', 'discord')).toBe(
      'https://app.kilo.ai/integrations/discord'
    );
    expect(getIntegrationPageUrl('https://app.kilo.ai/', 'bitbucket', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/integrations/bitbucket'
    );
  });
});

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

describe('getByokUrl', () => {
  it('builds personal and organization BYOK settings URLs', () => {
    expect(getByokUrl('https://app.kilo.ai')).toBe('https://app.kilo.ai/byok');
    expect(getByokUrl('https://app.kilo.ai/', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/byok'
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
