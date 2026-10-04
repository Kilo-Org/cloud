import {
  isSessionPullRequestLinkVerified,
  normalizeRepoUrl,
  parsePullRequestUrl,
  parseRepoReference,
  pullRequestUrlMatchesRepo,
  repoReferencesMatch,
  verifySessionPullRequestLink,
  type PullRequestFacts,
  type SessionPullRequestLink,
  type SessionRepoRef,
} from './pr-link-identity';

function sessionRepo(overrides: Partial<SessionRepoRef> = {}): SessionRepoRef {
  return {
    gitUrl: 'https://github.com/kilo/repo.git',
    gitBranch: 'feature/z',
    ...overrides,
  };
}

function sessionLink(overrides: Partial<SessionPullRequestLink> = {}): SessionPullRequestLink {
  return {
    prUrl: 'https://github.com/kilo/repo/pull/7',
    prNumber: 7,
    headRef: 'feature/z',
    headSha: 'abc123',
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: 7,
    baseRepoFullName: 'kilo/repo',
    headRepoFullName: 'kilo/repo',
    headRef: 'feature/z',
    headSha: 'abc123',
    ...overrides,
  };
}

function verify(
  repo: SessionRepoRef = sessionRepo(),
  link: SessionPullRequestLink = sessionLink(),
  pr: PullRequestFacts = pullRequest()
) {
  return verifySessionPullRequestLink({ sessionRepo: repo, link, pullRequest: pr });
}

describe('normalizeRepoUrl / parseRepoReference', () => {
  it('normalizes clone URL forms and full names to the same canonical url', () => {
    const expected = 'https://github.com/acme/widgets';
    for (const value of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets.git/',
      'https://github.com/ACME/widgets',
      'https://github.com/ACME/widgets/',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets',
      'acme/widgets',
      'acme/widgets.git',
      'github.com/acme/widgets',
    ]) {
      expect(normalizeRepoUrl(value)).toBe(expected);
    }
  });

  it('returns null for unparseable references instead of guessing', () => {
    for (const value of [null, undefined, '', '   ', 'not-a-repo']) {
      expect(parseRepoReference(value)).toBeNull();
      expect(normalizeRepoUrl(value)).toBeNull();
    }
  });

  it('compares only matching host + owner + repo', () => {
    expect(repoReferencesMatch('https://github.com/Kilo/Repo', 'kilo/repo')).toBe(true);
    expect(
      repoReferencesMatch('https://github.com/kilo/repo', 'https://github.com/kilo/other')
    ).toBe(false);
    expect(
      repoReferencesMatch('https://github.com/kilo/repo', 'https://gitlab.com/kilo/repo')
    ).toBe(false);
    expect(repoReferencesMatch(null, 'kilo/repo')).toBe(false);
  });
});

describe('parsePullRequestUrl / pullRequestUrlMatchesRepo', () => {
  it('parses a PR URL into its repo reference and number', () => {
    expect(parsePullRequestUrl('https://github.com/kilo/repo/pull/7')).toEqual({
      host: 'github.com',
      owner: 'kilo',
      repo: 'repo',
      number: 7,
      repoUrl: 'https://github.com/kilo/repo',
    });
    expect(parsePullRequestUrl('https://GitHub.com/Kilo/Repo/pull/42/files')?.number).toBe(42);
  });

  it.each([
    'https://github.com/kilo/repo/pull/7?diff=split#discussion',
    'github.com/kilo/repo/pull/7?diff=split#discussion',
    'kilo/repo/pull/7?diff=split#discussion',
    'https://github.com/kilo/repo/pull/7/files?diff=split#discussion',
  ])('preserves PR identity and repo matching for %s', value => {
    expect(parsePullRequestUrl(value)).toEqual({
      host: 'github.com',
      owner: 'kilo',
      repo: 'repo',
      number: 7,
      repoUrl: 'https://github.com/kilo/repo',
    });
    expect(pullRequestUrlMatchesRepo(value, 'git@github.com:kilo/repo.git')).toBe(true);
  });

  it.each([
    'https://github.com/kilo/repo?next=/pull/7',
    'https://github.com/kilo/repo#/pull/7',
    'github.com/kilo/repo?next=/pull/7',
    'github.com/kilo/repo#/pull/7',
    'https://github.com/prefix/kilo/repo/pull/7',
    'https://github.com/kilo/repo/issues/7?next=/pull/7',
    'https://github.com/kilo/repo/pull/7oops',
    'https://github.com/kilo/repo/pull/9007199254740992',
  ])('rejects a link without an actual owner/repo/PR-number path: %s', value => {
    expect(parsePullRequestUrl(value)).toBeNull();
    expect(pullRequestUrlMatchesRepo(value, 'https://github.com/kilo/repo')).toBe(false);
  });

  it('rejects non-PR URLs and non-positive numbers', () => {
    for (const value of [
      'https://github.com/kilo/repo',
      'https://github.com/kilo/repo/issues/7',
      'https://github.com/kilo/repo/pull/0',
      'https://github.com/kilo/repo/pull/-3',
      null,
    ]) {
      expect(parsePullRequestUrl(value)).toBeNull();
    }
  });

  it('matches only a PR URL whose owner/repo is the session repository', () => {
    expect(
      pullRequestUrlMatchesRepo(
        'https://github.com/kilo/repo/pull/7',
        'git@github.com:kilo/repo.git'
      )
    ).toBe(true);
    expect(
      pullRequestUrlMatchesRepo(
        'https://github.com/other/repo/pull/7',
        'https://github.com/kilo/repo'
      )
    ).toBe(false);
    expect(
      pullRequestUrlMatchesRepo('https://github.com/kilo/repo', 'https://github.com/kilo/repo')
    ).toBe(false);
    expect(pullRequestUrlMatchesRepo(null, 'https://github.com/kilo/repo')).toBe(false);
  });
});

describe('verifySessionPullRequestLink - accepts', () => {
  it('accepts the session own PR on matching repo, head repo, head ref and head SHA', () => {
    expect(verify()).toEqual({ verified: true, evidence: 'head_sha' });
    expect(
      isSessionPullRequestLinkVerified({
        sessionRepo: sessionRepo(),
        link: sessionLink(),
        pullRequest: pullRequest(),
      })
    ).toBe(true);
  });

  it('compares repo identity and SHAs case-insensitively', () => {
    expect(
      verify(
        sessionRepo({ gitUrl: 'https://github.com/KILO/Repo', gitBranch: 'feature/z' }),
        sessionLink({ prUrl: 'https://github.com/kilo/repo/pull/7', headSha: 'ABC123' }),
        pullRequest({
          baseRepoFullName: 'Kilo/Repo',
          headRepoFullName: 'kilo/repo',
          headSha: 'abc123',
        })
      )
    ).toEqual({ verified: true, evidence: 'head_sha' });
  });

  it('accepts when the session head SHA is one of the PR commits', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink({ headSha: 'deadbeef' }),
        pullRequest({ headSha: 'cafe', commitShas: ['cafe', 'deadbeef'] })
      )
    ).toEqual({ verified: true, evidence: 'commit_sha' });
  });

  it('accepts an older CLI without a head SHA on repo + head repo + head ref only', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink({ headSha: null }),
        pullRequest({ headSha: 'whoever-else-sha' })
      )
    ).toEqual({ verified: true, evidence: 'head_ref' });
  });

  it('accepts a commit SHA only when the commit list was actually fetched', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink({ headSha: 'deadbeef' }),
        pullRequest({ headSha: 'cafe', commitShas: ['cafe', 'deadbeef'] })
      )
    ).toEqual({ verified: true, evidence: 'commit_sha' });
    expect(
      verify(sessionRepo(), sessionLink({ headSha: 'deadbeef' }), pullRequest({ headSha: 'cafe' }))
    ).toEqual({ verified: false, reason: 'head_sha_mismatch' });
  });
});

describe('verifySessionPullRequestLink - rejects', () => {
  it('rejects a session with no stored link (no branch fallback)', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink({ prUrl: null, prNumber: null, headSha: null }),
        pullRequest()
      )
    ).toEqual({ verified: false, reason: 'missing_pr_url' });
  });

  it('rejects a stored link whose URL names another repository', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink({ prUrl: 'https://github.com/other/repo/pull/7' }),
        pullRequest()
      )
    ).toEqual({ verified: false, reason: 'pr_url_not_session_repo' });
  });

  it('rejects a same-named branch PR from another repository', () => {
    expect(
      verify(sessionRepo(), sessionLink(), pullRequest({ baseRepoFullName: 'other/repo' }))
    ).toEqual({ verified: false, reason: 'base_repo_mismatch' });
  });

  it('rejects a same-named branch PR from a fork (head repo differs)', () => {
    expect(
      verify(sessionRepo(), sessionLink(), pullRequest({ headRepoFullName: 'someone/repo' }))
    ).toEqual({ verified: false, reason: 'head_repo_mismatch' });
  });

  it('rejects when the head repository is gone (empty head repo)', () => {
    expect(verify(sessionRepo(), sessionLink(), pullRequest({ headRepoFullName: '' }))).toEqual({
      verified: false,
      reason: 'head_repo_mismatch',
    });
  });

  it('rejects a PR opened on the session branch by someone else (no matching head SHA)', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink(),
        pullRequest({ headRef: 'feature/other', headSha: 'other-sha' })
      )
    ).toEqual({ verified: false, reason: 'head_ref_mismatch' });
  });

  it('rejects when the session head SHA is not the PR head nor one of its commits', () => {
    expect(
      verify(
        sessionRepo(),
        sessionLink({ headSha: 'aaaa' }),
        pullRequest({ headSha: 'bbbb', commitShas: ['bbbb', 'cccc'] })
      )
    ).toEqual({ verified: false, reason: 'head_sha_mismatch' });
  });

  it('rejects when the PR number does not match the stored link', () => {
    expect(verify(sessionRepo(), sessionLink(), pullRequest({ number: 8 }))).toEqual({
      verified: false,
      reason: 'pr_number_mismatch',
    });
  });

  it('rejects when the session repository cannot be parsed', () => {
    expect(verify(sessionRepo({ gitUrl: null }), sessionLink(), pullRequest())).toEqual({
      verified: false,
      reason: 'missing_session_repo',
    });
  });

  it('rejects when the session branch and the reported head ref disagree', () => {
    expect(verify(sessionRepo(), sessionLink({ headRef: 'feature/other' }), pullRequest())).toEqual(
      { verified: false, reason: 'head_ref_mismatch' }
    );
  });

  it('rejects when the PR has no base repository evidence', () => {
    expect(verify(sessionRepo(), sessionLink(), pullRequest({ baseRepoFullName: null }))).toEqual({
      verified: false,
      reason: 'base_repo_mismatch',
    });
  });

  it('never links on the branch name alone when there is no session repo link', () => {
    // The old branch-fallback join would surface this row; the identity check
    // must refuse it because the session never reported the link.
    const result = verify(
      sessionRepo(),
      sessionLink({ prUrl: null, prNumber: null, headRef: null, headSha: null }),
      pullRequest()
    );
    expect(result.verified).toBe(false);
  });
});

describe('verifySessionPullRequestLink - several sessions, one repo and branch', () => {
  const repo = sessionRepo();
  const prA = pullRequest({ number: 7, headSha: 'sha-a' });
  const prB = pullRequest({ number: 8, headSha: 'sha-b' });

  it('shows each session only its own PR', () => {
    const linkA = sessionLink({
      prUrl: 'https://github.com/kilo/repo/pull/7',
      prNumber: 7,
      headSha: 'sha-a',
    });
    const linkB = sessionLink({
      prUrl: 'https://github.com/kilo/repo/pull/8',
      prNumber: 8,
      headSha: 'sha-b',
    });

    expect(verify(repo, linkA, prA)).toEqual({ verified: true, evidence: 'head_sha' });
    expect(verify(repo, linkB, prB)).toEqual({ verified: true, evidence: 'head_sha' });

    // Cross-checking the other session's PR is rejected: the stored link and
    // head SHA belong to the other PR.
    expect(verify(repo, linkA, prB)).toEqual({ verified: false, reason: 'pr_number_mismatch' });
    expect(verify(repo, linkB, prA)).toEqual({ verified: false, reason: 'pr_number_mismatch' });
    expect(verify(repo, linkA, pullRequest({ number: 7, headSha: 'sha-b' }))).toEqual({
      verified: false,
      reason: 'head_sha_mismatch',
    });
  });

  it('does not leak a newer PR to an older session on the reused branch name', () => {
    // Older session never reported a link, so the newer PR on the reused branch
    // name is not its PR.
    const olderSessionLink = sessionLink({
      prUrl: null,
      prNumber: null,
      headRef: null,
      headSha: null,
    });
    expect(verify(repo, olderSessionLink, prB).verified).toBe(false);
  });
});
