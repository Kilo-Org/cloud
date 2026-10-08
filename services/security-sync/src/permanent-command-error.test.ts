import { describe, expect, it } from 'vitest';
import {
  isGitHubInstallationAccessDeniedError,
  isPermanentSecurityCommandError,
  PermanentSecurityCommandError,
  permanentGithubDismissalFailure,
} from './permanent-command-error.js';

describe('permanentGithubDismissalFailure', () => {
  it.each([
    [401, 'GITHUB_AUTH_INVALID'],
    [403, 'GITHUB_AUTH_INVALID'],
    [404, 'REPOSITORY_UNAVAILABLE'],
    [410, 'REPOSITORY_UNAVAILABLE'],
    [422, 'DISMISSAL_REJECTED'],
  ] as const)('classifies GitHub %i as permanent %s', (status, resultCode) => {
    expect(permanentGithubDismissalFailure(status)).toMatchObject({ resultCode });
  });

  it.each([400, 408, 409, 429, 500, 502, 503, 504])('keeps GitHub %i transient', status => {
    expect(permanentGithubDismissalFailure(status)).toBeNull();
  });
});

describe('isPermanentSecurityCommandError', () => {
  it('matches only PermanentSecurityCommandError instances', () => {
    const permanent = new PermanentSecurityCommandError({
      resultCode: 'GITHUB_TOKEN_UNAVAILABLE',
      lastErrorRedacted: 'GitHub integration is disconnected or inactive for this finding',
    });
    expect(isPermanentSecurityCommandError(permanent)).toBe(true);
    expect(isPermanentSecurityCommandError(new Error('transient'))).toBe(false);
    expect(isPermanentSecurityCommandError('transient')).toBe(false);
    expect(isPermanentSecurityCommandError(undefined)).toBe(false);
  });
});

describe('isGitHubInstallationAccessDeniedError', () => {
  it('matches by preserved error name across the RPC boundary', () => {
    const error = new Error('GitHub installation is not available through one active association');
    error.name = 'GitHubInstallationAccessDeniedError';
    expect(isGitHubInstallationAccessDeniedError(error)).toBe(true);
    expect(isGitHubInstallationAccessDeniedError(new Error('network down'))).toBe(false);
    expect(isGitHubInstallationAccessDeniedError('GitHubInstallationAccessDeniedError')).toBe(
      false
    );
  });
});
