import { describe, expect, it } from 'vitest';
import { normalizeBitbucketUuid, parseBitbucketCloneUrl } from './bitbucket-url.js';

describe('parseBitbucketCloneUrl', () => {
  it('parses a canonical credential-free Bitbucket clone URL', () => {
    expect(parseBitbucketCloneUrl('https://bitbucket.org/acme/widgets.git')).toEqual({
      success: true,
      workspace: 'acme',
      repository: 'widgets',
      fullName: 'acme/widgets',
    });
  });

  it.each([
    'http://bitbucket.org/acme/widgets.git',
    'ssh://git@bitbucket.org/acme/widgets.git',
    'git@bitbucket.org:acme/widgets.git',
    'https://user@bitbucket.org/acme/widgets.git',
    'https://user:password@bitbucket.org/acme/widgets.git',
    'https://bitbucket.org:443/acme/widgets.git',
    'https://bitbucket.org:8443/acme/widgets.git',
    'https://bitbucket.org/acme/widgets.git?ref=main',
    'https://bitbucket.org/acme/widgets.git#readme',
    'https://bitbucket.org/acme%2Fother/widgets.git',
    'https://bitbucket.org/acme%252Fother/widgets.git',
    'https://bitbucket.org/acme%5Cother/widgets.git',
    'https://bitbucket.org/acme/widgets%2Fother.git',
    'https://bitbucket.org/acme/widgets%5Cother.git',
    'https://bitbucket.org/acme/widgets%255Cother.git',
    'https://bitbucket.org/acme\\other/widgets.git',
    'https://bitbucket.org/./widgets.git',
    'https://bitbucket.org/acme/../widgets.git',
    'https://bitbucket.org/%2e/widgets.git',
    'https://bitbucket.org/%252e%252e/widgets.git',
    'https://bitbucket.org/acme/%2e%2e.git',
    'https://bitbucket.org/acme/%2e..git',
    'https://bitbucket.org//acme/widgets.git',
    'https://bitbucket.org/acme//widgets.git',
    'https://bitbucket.org/acme/widgets/extra.git',
    'https://bitbucket.org/acme/widgets.git/extra',
    'https://bitbucket.org/ac%ZZme/widgets.git',
    'https://bitbucket.org/acme/%E0%A4%A.git',
    'https://bitbucket.org/acme/widgets',
    'https://bitbucket.org/acme/widgets.GIT',
    'https://bitbucket.org/acme/.git',
    'https://bitbucket.org/acme/widgets.git/',
    'https://bitbucket.org.evil.example/acme/widgets.git',
    'https://bitbucket.org./acme/widgets.git',
    'HTTPS://bitbucket.org/acme/widgets.git',
  ])('rejects non-canonical or unsafe URL %s', repositoryUrl => {
    expect(parseBitbucketCloneUrl(repositoryUrl)).toEqual({
      success: false,
      reason: 'invalid_bitbucket_url',
    });
  });
});

describe('normalizeBitbucketUuid', () => {
  it.each([
    ['A07D5C40-2D2D-4E79-A812-6A47824A77D6', 'a07d5c40-2d2d-4e79-a812-6a47824a77d6'],
    ['{a07d5c40-2d2d-4e79-a812-6a47824a77d6}', 'a07d5c40-2d2d-4e79-a812-6a47824a77d6'],
    ['{A07D5C40-2D2D-4E79-A812-6A47824A77D6}', 'a07d5c40-2d2d-4e79-a812-6a47824a77d6'],
  ])('normalizes provider UUID %s', (providerUuid, expected) => {
    expect(normalizeBitbucketUuid(providerUuid)).toBe(expected);
  });

  it.each([
    '',
    '{}',
    '{a07d5c40-2d2d-4e79-a812-6a47824a77d6',
    'a07d5c40-2d2d-4e79-a812-6a47824A77D6}',
    '{a07d5c40-2d2d-4e79-a812-6a47824a77d6}}',
    'not-a-uuid',
    'a07d5c402d2d4e79a8126a47824a77d6',
  ])('rejects malformed provider UUID %s', providerUuid => {
    expect(normalizeBitbucketUuid(providerUuid)).toBeNull();
  });
});
