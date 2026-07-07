import { describe, expect, it } from 'vitest';

import { getGitLabIntegrationUrl } from './integration-urls';

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
