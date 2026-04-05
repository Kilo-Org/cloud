/**
 * Tests for sanitizeGitError function.
 *
 * Ensures access tokens are properly redacted from error messages,
 * including tokens that contain regex special characters.
 */

import { sanitizeGitError } from '../sanitize-git-error';

describe('sanitizeGitError', () => {
  it('should return the original error when no access token is provided', () => {
    const originalError = new Error('Some git error');
    const result = sanitizeGitError(originalError, undefined);

    expect(result).toBe(originalError);
    expect(result.message).toBe('Some git error');
  });

  it('should convert non-Error values to Error when no access token is provided', () => {
    const result = sanitizeGitError('string error', undefined);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string error');
  });

  it('should redact access token from error message', () => {
    const accessToken = 'ghp_abc123xyz';
    const error = new Error(
      `Failed to clone https://x-access-token:${accessToken}@github.com/user/repo`
    );

    const result = sanitizeGitError(error, accessToken);

    expect(result.message).toBe(
      'Failed to clone https://x-access-token:[REDACTED]@github.com/user/repo'
    );
    expect(result.message).not.toContain(accessToken);
  });

  it('should redact multiple occurrences of access token', () => {
    const accessToken = 'ghp_abc123xyz';
    const error = new Error(`Token ${accessToken} failed. Retry with ${accessToken} also failed.`);

    const result = sanitizeGitError(error, accessToken);

    expect(result.message).toBe('Token [REDACTED] failed. Retry with [REDACTED] also failed.');
    expect(result.message).not.toContain(accessToken);
  });

  it('should redact access token from error stack', () => {
    const accessToken = 'ghp_abc123xyz';
    const error = new Error(`Clone failed with token ${accessToken}`);
    error.stack = `Error: Clone failed with token ${accessToken}\n    at clone (git.js:10)\n    at ${accessToken}`;

    const result = sanitizeGitError(error, accessToken);

    expect(result.stack).toBe(
      'Error: Clone failed with token [REDACTED]\n    at clone (git.js:10)\n    at [REDACTED]'
    );
    expect(result.stack).not.toContain(accessToken);
  });

  it('should handle tokens with regex special characters safely', () => {
    // Token containing regex special characters: . * + ? ^ $ { } [ ] \ | ( )
    const accessToken = 'token.with*special+chars?and^more$chars';
    const error = new Error(`Failed with token: ${accessToken}`);

    const result = sanitizeGitError(error, accessToken);

    expect(result.message).toBe('Failed with token: [REDACTED]');
    expect(result.message).not.toContain(accessToken);
  });

  it('should handle tokens with backslashes', () => {
    const accessToken = 'token\\with\\backslashes';
    const error = new Error(`Auth failed: ${accessToken}`);

    const result = sanitizeGitError(error, accessToken);

    expect(result.message).toBe('Auth failed: [REDACTED]');
    expect(result.message).not.toContain(accessToken);
  });

  it('should handle tokens with parentheses and brackets', () => {
    const accessToken = 'token(with)[brackets]{and}pipes|here';
    const error = new Error(`Error: ${accessToken}`);

    const result = sanitizeGitError(error, accessToken);

    expect(result.message).toBe('Error: [REDACTED]');
    expect(result.message).not.toContain(accessToken);
  });

  it('should convert non-Error values to Error when access token is provided', () => {
    const accessToken = 'ghp_secret';
    const result = sanitizeGitError(`string error with ${accessToken}`, accessToken);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string error with [REDACTED]');
    expect(result.message).not.toContain(accessToken);
  });

  it('should handle empty access token', () => {
    const error = new Error('Some error');
    const result = sanitizeGitError(error, '');

    expect(result).toBe(error);
  });
});
