import {
  buildGitHubPullRequestHead,
  parseGitHubRepositoryCoordinates,
} from '@/lib/github/pull-request-head';

describe('parseGitHubRepositoryCoordinates', () => {
  it('splits an owner/repo full name', () => {
    expect(parseGitHubRepositoryCoordinates('Kilo-Org/cloud')).toEqual({
      owner: 'Kilo-Org',
      repo: 'cloud',
    });
  });

  it('accepts every character GitHub permits: owners are alphanumeric with hyphens, names add dot and underscore', () => {
    expect(parseGitHubRepositoryCoordinates('my-org/kilo.cloud_2-x')).toEqual({
      owner: 'my-org',
      repo: 'kilo.cloud_2-x',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseGitHubRepositoryCoordinates('  maphew/kilo-cloud ')).toEqual({
      owner: 'maphew',
      repo: 'kilo-cloud',
    });
  });

  it.each([
    'cloud',
    'a/b/c',
    'a/b/',
    '/cloud',
    'Kilo-Org/',
    'Kilo Org/cloud',
    '',
    'https://github.com/o/r',
    'a/b?x=y',
    'a/b#c',
    '../etc/passwd',
    '-leading-hyphen/repo',
    'my_org/repo',
  ])('rejects %p', fullName => {
    expect(parseGitHubRepositoryCoordinates(fullName)).toBeNull();
  });

  it.each(['owner/.', 'owner/..', './repo', '../repo', './..'])(
    'rejects %p, because relative segments URL-normalize out of a GitHub request path',
    fullName => {
      expect(parseGitHubRepositoryCoordinates(fullName)).toBeNull();
    }
  );
});

describe('buildGitHubPullRequestHead', () => {
  const baseRepository = { owner: 'Kilo-Org', repo: 'kilo-cloud' };

  it('omits head_repo when the head repository is the base repository', () => {
    expect(
      buildGitHubPullRequestHead({
        headBranch: 'session/abc',
        headRepository: { owner: 'Kilo-Org', repo: 'kilo-cloud' },
        baseRepository,
      }).headRepo
    ).toBeNull();
  });

  it('omits head_repo when the head repository differs only by case, because GitHub names are case-insensitive', () => {
    expect(
      buildGitHubPullRequestHead({
        headBranch: 'session/abc',
        headRepository: { owner: 'kilo-org', repo: 'Kilo-Cloud' },
        baseRepository,
      })
    ).toEqual({
      branch: 'session/abc',
      ref: 'session/abc',
      headRepo: null,
      repository: { owner: 'kilo-org', repo: 'Kilo-Cloud' },
    });
  });

  it('qualifies the head and names the head repository for a cross-fork pull', () => {
    expect(
      buildGitHubPullRequestHead({
        headBranch: 'kilo/fresh-trail-let',
        headRepository: { owner: 'maphew', repo: 'kilo-cloud' },
        baseRepository,
      })
    ).toEqual({
      branch: 'kilo/fresh-trail-let',
      ref: 'maphew:kilo/fresh-trail-let',
      headRepo: 'maphew/kilo-cloud',
      repository: { owner: 'maphew', repo: 'kilo-cloud' },
    });
  });

  it('still names head_repo when the fork lives under the base owner, where owner:branch cannot disambiguate', () => {
    expect(
      buildGitHubPullRequestHead({
        headBranch: 'session/abc',
        headRepository: { owner: 'Kilo-Org', repo: 'renamed-kilo-cloud' },
        baseRepository,
      })
    ).toEqual({
      branch: 'session/abc',
      ref: 'Kilo-Org:session/abc',
      headRepo: 'Kilo-Org/renamed-kilo-cloud',
      repository: { owner: 'Kilo-Org', repo: 'renamed-kilo-cloud' },
    });
  });

  it('normalizes a fully qualified ref and trims whitespace', () => {
    expect(
      buildGitHubPullRequestHead({
        headBranch: '  refs/heads/session/abc  ',
        headRepository: { owner: 'maphew', repo: 'kilo-cloud' },
        baseRepository,
      })
    ).toEqual({
      branch: 'session/abc',
      ref: 'maphew:session/abc',
      headRepo: 'maphew/kilo-cloud',
      repository: { owner: 'maphew', repo: 'kilo-cloud' },
    });
  });

  it.each(['', '   ', 'refs/heads/'])('rejects an empty head branch (%p)', headBranch => {
    expect(() =>
      buildGitHubPullRequestHead({ headBranch, headRepository: baseRepository, baseRepository })
    ).toThrow('Pull request head branch must not be empty');
  });
});
