import { describe, expect, it } from 'vitest';

import {
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
    expect(getIntegrationPageUrl('https://app.kilo.ai/', 'gitlab', 'org_123')).toBe(
      'https://app.kilo.ai/organizations/org_123/integrations/gitlab'
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
