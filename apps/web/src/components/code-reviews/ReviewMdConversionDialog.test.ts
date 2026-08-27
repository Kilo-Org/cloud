import { describe, expect, it } from '@jest/globals';

import {
  buildConversionHref,
  conversionIntegrationId,
  conversionRepositoryDiscriminator,
} from './ReviewMdConversionDialog';

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

describe('REVIEW.md repository selection', () => {
  const repository = {
    id: 1,
    full_name: 'acme/widgets',
    platformIntegrationId: '00000000-0000-4000-8000-000000000002',
    platformAccountLogin: 'acme',
    githubAppType: 'lite',
  };

  it('omits integration identity for a unique repository', () => {
    expect(conversionIntegrationId(repository, new Set())).toBeUndefined();
    expect(conversionRepositoryDiscriminator(repository, new Set())).toBeNull();
  });

  it('visibly distinguishes and submits an explicit duplicate repository choice', () => {
    const duplicates = new Set(['acme/widgets']);

    expect(conversionIntegrationId(repository, duplicates)).toBe(
      '00000000-0000-4000-8000-000000000002'
    );
    expect(conversionRepositoryDiscriminator(repository, duplicates)).toBe('acme · lite app');
  });
});
