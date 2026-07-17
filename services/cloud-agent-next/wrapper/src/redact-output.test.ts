import { describe, expect, it } from 'bun:test';
import { redactSecrets } from './redact-output';

describe('redactSecrets', () => {
  it('redacts bearer tokens in Authorization headers', () => {
    expect(redactSecrets('Authorization: Bearer ghp_abc123def456')).toBe(
      'Authorization: Bearer [REDACTED]'
    );
  });

  it('redacts basic auth in Authorization headers', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Authorization: Basic [REDACTED]'
    );
  });

  it('redacts URL-embedded credentials', () => {
    expect(redactSecrets('https://user:password@example.com/repo.git')).toBe(
      'https://[REDACTED]@example.com/repo.git'
    );
    expect(
      redactSecrets('Cloning into https://x-access-token:ghs_token@github.com/owner/repo')
    ).toBe('Cloning into https://[REDACTED]@github.com/owner/repo');
    expect(redactSecrets('https://single-token@example.com/repo.git')).toBe(
      'https://[REDACTED]@example.com/repo.git'
    );
  });

  it('redacts Cookie headers', () => {
    expect(redactSecrets('Cookie: session=abc123; csrf=xyz')).toBe('Cookie: [REDACTED]');
  });

  it('redacts KEY=VALUE where key contains secret-like names', () => {
    expect(redactSecrets('SECRET_VALUE=env-secret')).toBe('SECRET_VALUE=[REDACTED]');
    expect(redactSecrets('GITHUB_TOKEN=ghp_abc123')).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(redactSecrets('export DATABASE_PASSWORD=hunter2')).toBe(
      'export DATABASE_PASSWORD=[REDACTED]'
    );
    expect(redactSecrets('API_KEY=sk-abc123')).toBe('API_KEY=[REDACTED]');
    expect(redactSecrets('DATABASE_PASSWORD="secret with spaces"')).toBe(
      'DATABASE_PASSWORD=[REDACTED]'
    );
  });

  it('does not redact non-secret KEY=VALUE pairs', () => {
    expect(redactSecrets('PATH=/usr/local/bin')).toBe('PATH=/usr/local/bin');
    expect(redactSecrets('NODE_ENV=production')).toBe('NODE_ENV=production');
    expect(redactSecrets('HOME=/home/user')).toBe('HOME=/home/user');
  });

  it('redacts CLI flags with secret values', () => {
    expect(redactSecrets('private-tool --token argv-secret')).toBe(
      'private-tool --token [REDACTED]'
    );
    expect(redactSecrets('curl --password mypass https://example.com')).toBe(
      'curl --password [REDACTED] https://example.com'
    );
    expect(redactSecrets('tool --api-key=sk_abc123')).toBe('tool --api-key=[REDACTED]');
    expect(redactSecrets("tool --github-token 'secret with spaces'")).toBe(
      'tool --github-token [REDACTED]'
    );
  });

  it('redacts multiple secrets in multi-line output', () => {
    const input = [
      'bare-unlabeled-token',
      'https://user:url-secret@example.com/repo.git',
      'Authorization: Bearer bearer-secret',
      'Cookie: session=cookie-secret',
      'SECRET_VALUE=env-secret',
    ].join('\n');

    const result = redactSecrets(input);
    expect(result).not.toContain('url-secret');
    expect(result).not.toContain('bearer-secret');
    expect(result).not.toContain('cookie-secret');
    expect(result).not.toContain('env-secret');
    expect(result).toContain('https://[REDACTED]@example.com/repo.git');
    expect(result).toContain('Authorization: Bearer [REDACTED]');
    expect(result).toContain('Cookie: [REDACTED]');
    expect(result).toContain('SECRET_VALUE=[REDACTED]');
  });

  it('leaves non-secret content unchanged', () => {
    expect(redactSecrets('npm install')).toBe('npm install');
    expect(redactSecrets('added 42 packages in 3s')).toBe('added 42 packages in 3s');
    expect(redactSecrets('Error: ENOENT: no such file or directory')).toBe(
      'Error: ENOENT: no such file or directory'
    );
  });
});
