import { describe, it, expect } from 'vitest';
import { redactSensitiveHeaders, redactGitHubTokens } from './redact-headers.js';

describe('redactSensitiveHeaders', () => {
  it('redacts known sensitive headers (lowercase)', () => {
    const input = {
      authorization: 'Bearer secret-jwt',
      'proxy-authorization': 'Basic cHJveHk6c2VjcmV0',
      cookie: 'session=abc123',
      'set-cookie': 'session=abc123; Path=/',
      'x-gitlab-token': 'glpat-secret',
      'x-hub-signature': 'sha1=abc',
      'x-hub-signature-256': 'sha256=def',
      'content-type': 'application/json',
      'x-request-id': '123',
    };

    const result = redactSensitiveHeaders(input);

    expect(result).toEqual({
      authorization: '[REDACTED]',
      'proxy-authorization': '[REDACTED]',
      cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      'x-gitlab-token': '[REDACTED]',
      'x-hub-signature': '[REDACTED]',
      'x-hub-signature-256': '[REDACTED]',
      'content-type': 'application/json',
      'x-request-id': '123',
    });
  });

  it('handles mixed-case header keys', () => {
    const input = {
      Authorization: 'Bearer token',
      'X-Hub-Signature-256': 'sha256=abc',
      'Content-Type': 'text/plain',
    };

    const result = redactSensitiveHeaders(input);

    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['X-Hub-Signature-256']).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('text/plain');
  });

  it('preserves original key casing', () => {
    const input = { Authorization: 'Bearer x' };
    const result = redactSensitiveHeaders(input);
    expect(Object.keys(result)).toEqual(['Authorization']);
  });

  it('returns empty object for empty input', () => {
    expect(redactSensitiveHeaders({})).toEqual({});
  });

  it('does not mutate the input', () => {
    const input = { authorization: 'Bearer secret' };
    const result = redactSensitiveHeaders(input);
    expect(input.authorization).toBe('Bearer secret');
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('redacts extra headers passed by caller', () => {
    const input = {
      'x-webhook-secret': 'my-secret',
      'x-custom-auth': 'token-123',
      'content-type': 'application/json',
    };

    const result = redactSensitiveHeaders(input, ['x-webhook-secret', 'X-Custom-Auth']);

    expect(result['x-webhook-secret']).toBe('[REDACTED]');
    expect(result['x-custom-auth']).toBe('[REDACTED]');
    expect(result['content-type']).toBe('application/json');
  });

  it('works with empty extraHeaders array', () => {
    const input = { authorization: 'Bearer token', 'x-foo': 'bar' };
    const result = redactSensitiveHeaders(input, []);
    expect(result.authorization).toBe('[REDACTED]');
    expect(result['x-foo']).toBe('bar');
  });
});

describe('redactGitHubTokens', () => {
  it('redacts ghu_ tokens', () => {
    const input = 'token ghu_abc123def456 and more';
    expect(redactGitHubTokens(input)).toBe('token [REDACTED] and more');
  });

  it('redacts ghr_ tokens', () => {
    const input = 'refresh ghr_xyz789-uvw_123 and more';
    expect(redactGitHubTokens(input)).toBe('refresh [REDACTED] and more');
  });

  it('redacts multiple tokens in one string', () => {
    const input = 'user=ghu_a&refresh=ghr_b';
    expect(redactGitHubTokens(input)).toBe('user=[REDACTED]&refresh=[REDACTED]');
  });

  it('leaves unrelated strings untouched', () => {
    const input = 'ghp_abc123 github_pat_123';
    expect(redactGitHubTokens(input)).toBe('ghp_abc123 github_pat_123');
  });

  it('returns the input unchanged when no tokens are present', () => {
    const input = 'no tokens here';
    expect(redactGitHubTokens(input)).toBe('no tokens here');
  });
});
