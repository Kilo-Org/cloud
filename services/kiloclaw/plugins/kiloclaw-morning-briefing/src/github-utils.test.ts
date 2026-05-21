import { describe, expect, it } from 'vitest';
import {
  buildGithubEmptySectionLines,
  buildGithubEmptySummary,
  classifyGithubToken,
  formatGithubTldr,
  type GithubEmptyResultContext,
  GITHUB_EMPTY_LINE,
  isCleanGithubEmptyResult,
  missingBriefingScopes,
  parseOAuthScopesHeader,
  readGithubTokenFromEnv,
} from './github-utils';

describe('classifyGithubToken', () => {
  it('detects classic PATs by ghp_ prefix', () => {
    expect(classifyGithubToken('ghp_abc123def456')).toBe('classic');
  });

  it('detects fine-grained PATs by github_pat_ prefix', () => {
    expect(classifyGithubToken('github_pat_11ABC123_xxxxx')).toBe('fine-grained');
  });

  it('detects GitHub App installation tokens by ghs_ prefix', () => {
    expect(classifyGithubToken('ghs_xxxxx')).toBe('app');
  });

  it('detects OAuth user-to-server tokens by gho_ prefix', () => {
    expect(classifyGithubToken('gho_xxxxx')).toBe('oauth');
  });

  it('returns unknown for empty / null / undefined', () => {
    expect(classifyGithubToken(undefined)).toBe('unknown');
    expect(classifyGithubToken(null)).toBe('unknown');
    expect(classifyGithubToken('')).toBe('unknown');
  });

  it('returns unknown for unrecognised prefixes', () => {
    expect(classifyGithubToken('xxxxx')).toBe('unknown');
    expect(classifyGithubToken('Bearer ghp_xxx')).toBe('unknown');
  });
});

describe('parseOAuthScopesHeader', () => {
  it('extracts a single scope', () => {
    expect(parseOAuthScopesHeader('X-OAuth-Scopes: repo\nDate: now')).toEqual(['repo']);
  });

  it('extracts multiple comma-separated scopes', () => {
    const blob = 'Foo: bar\nX-OAuth-Scopes: repo, read:org, user:email\nBaz: qux';
    expect(parseOAuthScopesHeader(blob)).toEqual(['repo', 'read:org', 'user:email']);
  });

  it('is case-insensitive on the header name', () => {
    expect(parseOAuthScopesHeader('x-oauth-scopes: repo, read:org')).toEqual(['repo', 'read:org']);
    expect(parseOAuthScopesHeader('X-OAUTH-SCOPES: repo')).toEqual(['repo']);
  });

  it('returns an empty array when the header is missing', () => {
    expect(parseOAuthScopesHeader('Date: now\nFoo: bar')).toEqual([]);
  });

  it('returns an empty array when the header value is empty', () => {
    expect(parseOAuthScopesHeader('X-OAuth-Scopes: \nDate: now')).toEqual([]);
  });

  it('filters out blank entries', () => {
    expect(parseOAuthScopesHeader('X-OAuth-Scopes: repo, , read:org')).toEqual([
      'repo',
      'read:org',
    ]);
  });

  it('handles \\r\\n line separators', () => {
    expect(
      parseOAuthScopesHeader('Foo: bar\r\nX-OAuth-Scopes: repo, read:org\r\nDate: now')
    ).toEqual(['repo', 'read:org']);
  });
});

describe('missingBriefingScopes', () => {
  it('returns repo when not granted', () => {
    expect(missingBriefingScopes(['public_repo', 'read:user'])).toEqual(['repo']);
  });

  it('returns empty when repo is granted', () => {
    expect(missingBriefingScopes(['repo', 'read:user'])).toEqual([]);
  });

  it('treats public_repo as not satisfying repo', () => {
    expect(missingBriefingScopes(['public_repo'])).toEqual(['repo']);
  });
});

describe('buildGithubEmptySectionLines', () => {
  it('renders classic-PAT-missing-scope copy', () => {
    const lines = buildGithubEmptySectionLines({
      tokenType: 'classic',
      login: 'astormsocbot',
      scopes: ['public_repo', 'read:user'],
      missingScopes: ['repo'],
    });
    const text = lines.join('\n');
    expect(text).toContain('Authenticated as `astormsocbot` (classic PAT)');
    expect(text).toContain('Granted scopes: public_repo, read:user');
    expect(text).toContain('Missing scopes useful for KiloClaw: repo');
    expect(text).toContain('gh auth refresh -h github.com');
    expect(text).toContain('https://github.com/settings/tokens');
  });

  it('renders classic-PAT-scopes-look-right copy', () => {
    const lines = buildGithubEmptySectionLines({
      tokenType: 'classic',
      login: 'astormsocbot',
      scopes: ['repo', 'read:org'],
      missingScopes: [],
    });
    const text = lines.join('\n');
    expect(text).toContain('Token has the scopes the brief needs');
    expect(text).not.toContain('Missing scopes');
    expect(text).not.toContain('gh auth refresh');
  });

  it('renders fine-grained-PAT copy with repo count', () => {
    const lines = buildGithubEmptySectionLines({
      tokenType: 'fine-grained',
      login: 'astormsocbot',
      accessibleRepoCount: 3,
    });
    const text = lines.join('\n');
    expect(text).toContain('Authenticated as `astormsocbot` (fine-grained PAT)');
    expect(text).toContain('Token can see 3 repositories');
    expect(text).toContain('explicitly granted access to');
    expect(text).toContain('switch to a classic PAT with `repo` scope');
    expect(text).toContain('https://github.com/settings/personal-access-tokens');
  });

  it.each(['app', 'oauth', 'unknown'] as const)('renders %s-token fallback copy', tokenType => {
    const lines = buildGithubEmptySectionLines({
      tokenType,
      login: 'someone',
    });
    const text = lines.join('\n');
    expect(text).toContain(`(${tokenType} token)`);
    expect(text).toContain('Authenticated as `someone`');
  });

  it('renders unknown-token-no-login copy', () => {
    const lines = buildGithubEmptySectionLines({
      tokenType: 'unknown',
      login: null,
    });
    const text = lines.join('\n');
    expect(text).toContain('Authenticated as `<unknown>`');
  });
});

describe('buildGithubEmptySummary', () => {
  it('summarises classic-PAT missing scopes', () => {
    expect(
      buildGithubEmptySummary({
        tokenType: 'classic',
        login: 'astormsocbot',
        scopes: ['public_repo'],
        missingScopes: ['repo'],
      })
    ).toBe('0 issues — classic PAT missing scopes: repo');
  });

  it('summarises classic-PAT happy path', () => {
    expect(
      buildGithubEmptySummary({
        tokenType: 'classic',
        login: 'astormsocbot',
        scopes: ['repo'],
        missingScopes: [],
      })
    ).toBe('0 issues involving astormsocbot');
  });

  it('summarises fine-grained PAT', () => {
    expect(
      buildGithubEmptySummary({
        tokenType: 'fine-grained',
        login: 'astormsocbot',
        accessibleRepoCount: 3,
      })
    ).toBe('0 issues — fine-grained PAT for astormsocbot sees 3 repos');
  });

  it('summarises unknown token', () => {
    expect(buildGithubEmptySummary({ tokenType: 'unknown', login: null })).toBe(
      '0 issues — could not detect token type or scopes'
    );
  });
});

describe('readGithubTokenFromEnv', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN when both set', () => {
    expect(readGithubTokenFromEnv({ GH_TOKEN: 'ghp_gh', GITHUB_TOKEN: 'ghp_github' })).toBe(
      'ghp_gh'
    );
  });

  it('falls back to GITHUB_TOKEN', () => {
    expect(readGithubTokenFromEnv({ GITHUB_TOKEN: 'ghp_github' })).toBe('ghp_github');
  });

  it('returns undefined when neither is set', () => {
    expect(readGithubTokenFromEnv({})).toBeUndefined();
  });

  it('trims whitespace and treats empty / whitespace-only as unset', () => {
    expect(readGithubTokenFromEnv({ GH_TOKEN: '  ', GITHUB_TOKEN: 'ghp_github' })).toBe(
      'ghp_github'
    );
    expect(readGithubTokenFromEnv({ GH_TOKEN: '  ghp_gh  ' })).toBe('ghp_gh');
  });
});

describe('isCleanGithubEmptyResult', () => {
  it('is true for a classic PAT with no missing scopes', () => {
    const ctx: GithubEmptyResultContext = {
      tokenType: 'classic',
      login: 'octocat',
      scopes: ['repo'],
      missingScopes: [],
    };
    expect(isCleanGithubEmptyResult(ctx)).toBe(true);
  });

  it('is false when the classic PAT is missing scopes', () => {
    const ctx: GithubEmptyResultContext = {
      tokenType: 'classic',
      login: 'octocat',
      scopes: [],
      missingScopes: ['repo'],
    };
    expect(isCleanGithubEmptyResult(ctx)).toBe(false);
  });

  it('is false for fine-grained and unknown token types', () => {
    expect(
      isCleanGithubEmptyResult({
        tokenType: 'fine-grained',
        login: 'octocat',
        accessibleRepoCount: 3,
      })
    ).toBe(false);
    expect(isCleanGithubEmptyResult({ tokenType: 'unknown', login: null })).toBe(false);
  });
});

describe('formatGithubTldr', () => {
  it('pluralizes the issue count', () => {
    expect(formatGithubTldr(3)).toBe('3 GitHub issues to review');
    expect(formatGithubTldr(1)).toBe('1 GitHub issue to review');
  });

  it('returns an empty string when there is nothing to count', () => {
    expect(formatGithubTldr(0)).toBe('');
  });
});

describe('GITHUB_EMPTY_LINE', () => {
  it('is an italic-wrapped one-liner', () => {
    expect(GITHUB_EMPTY_LINE.startsWith('_')).toBe(true);
    expect(GITHUB_EMPTY_LINE.endsWith('_')).toBe(true);
  });
});
