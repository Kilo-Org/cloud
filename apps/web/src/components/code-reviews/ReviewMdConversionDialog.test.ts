import { describe, expect, it } from '@jest/globals';

import { buildConversionHref } from './ReviewMdConversionDialog';

describe('buildConversionHref', () => {
  it('forwards authoritative GitHub integration identity to Cloud Agent creation', () => {
    const href = buildConversionHref({
      organizationId: '00000000-0000-4000-8000-000000000001',
      platform: 'github',
      repoFullName: 'acme/widgets',
      platformIntegrationId: '00000000-0000-4000-8000-000000000002',
    });
    const url = new URL(href, 'https://kilo.test');

    expect(url.searchParams.get('repo')).toBe('acme/widgets');
    expect(url.searchParams.get('platformIntegrationId')).toBe(
      '00000000-0000-4000-8000-000000000002'
    );
  });

  it('submits repository identity without inventing an integration ID', () => {
    const href = buildConversionHref({
      platform: 'github',
      repoFullName: 'acme/widgets',
    });
    const url = new URL(href, 'https://kilo.test');

    expect(url.searchParams.get('repo')).toBe('acme/widgets');
    expect(url.searchParams.has('platformIntegrationId')).toBe(false);
  });
});
