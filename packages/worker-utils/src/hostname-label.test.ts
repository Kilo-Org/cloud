import { describe, it, expect } from 'vitest';
import { sandboxIdFromUserId } from './sandbox-id';
import { sandboxIdFromInstanceId } from './instance-id';
import {
  hostnameLabelFromSandboxId,
  sandboxIdFromHostnameLabel,
  instanceUrl,
  parseInstanceHost,
  MAX_HOSTNAME_LABEL_LENGTH,
} from './hostname-label';

describe('hostnameLabelFromSandboxId', () => {
  it('maps an instance-keyed sandboxId to `i-{32hex}`', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(sandboxId).toBe('ki_550e8400e29b41d4a716446655440000');

    expect(hostnameLabelFromSandboxId(sandboxId)).toBe('i-550e8400e29b41d4a716446655440000');
  });

  it('maps a legacy UUID userId sandboxId to lowercase `u-{base32hex(userId)}`', () => {
    const sandboxId = sandboxIdFromUserId('550e8400-e29b-41d4-a716-446655440000');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(label?.startsWith('u-')).toBe(true);
    expect(label).toMatch(/^u-[0-9a-v]+$/);
    expect(label).toBe(label?.toLowerCase());
  });

  it('maps a legacy oauth-provider userId sandboxId to a safe label', () => {
    const sandboxId = sandboxIdFromUserId('oauth/google:118234567890');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(label).toMatch(/^u-[0-9a-v]+$/);
    expect(label).toBe(label?.toLowerCase());
  });

  it('maps a legacy email-shaped userId sandboxId to a safe label', () => {
    const sandboxId = sandboxIdFromUserId('user+tag@example.com');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(label).toMatch(/^u-[0-9a-v]+$/);
    expect(label).toBe(label?.toLowerCase());
  });

  it('maps legacy sandboxIds containing base64url `-` or `_` to safe labels', () => {
    const sandboxIdWithDash = sandboxIdFromUserId('ab>');
    expect(sandboxIdWithDash).toMatch(/-/);
    expect(hostnameLabelFromSandboxId(sandboxIdWithDash)).toBe('u-c5h3s');

    const sandboxIdWithUnderscore = sandboxIdFromUserId('ab?');
    expect(sandboxIdWithUnderscore).toMatch(/_/);
    expect(hostnameLabelFromSandboxId(sandboxIdWithUnderscore)).toBe('u-c5h3u');
  });

  it('returns null when the label would exceed the DNS label length', () => {
    // 39 raw bytes -> 63 base32 chars + `u-` = 65, over the 63-char limit.
    const overlongSandboxId = sandboxIdFromUserId('a'.repeat(39));
    expect(hostnameLabelFromSandboxId(overlongSandboxId)).toBeNull();

    // 38 raw bytes -> 61 base32 chars + `u-` = 63, exactly at the limit.
    const atLimitSandboxId = sandboxIdFromUserId('a'.repeat(38));
    const label = hostnameLabelFromSandboxId(atLimitSandboxId);
    expect(label?.length).toBe(MAX_HOSTNAME_LABEL_LENGTH);
  });
});

describe('sandboxIdFromHostnameLabel', () => {
  it('roundtrips an instance-keyed label', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(sandboxIdFromHostnameLabel(label ?? '')).toBe(sandboxId);
  });

  it('roundtrips legacy userId shapes', () => {
    const inputs = [
      '550e8400-e29b-41d4-a716-446655440000',
      'oauth/google:118234567890',
      'user+tag@example.com',
      'user_abc123',
      '118234567890',
    ];

    for (const userId of inputs) {
      const sandboxId = sandboxIdFromUserId(userId);
      const label = hostnameLabelFromSandboxId(sandboxId);
      expect(label, `userId=${userId}`).not.toBeNull();
      expect(sandboxIdFromHostnameLabel(label ?? ''), `userId=${userId}`).toBe(sandboxId);
    }
  });

  it('parses labels case-insensitively', () => {
    const instanceSandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(sandboxIdFromHostnameLabel('I-550E8400E29B41D4A716446655440000')).toBe(
      instanceSandboxId
    );

    const legacySandboxId = sandboxIdFromUserId('oauth/google:118234567890');
    const label = hostnameLabelFromSandboxId(legacySandboxId);
    expect(label).not.toBeNull();
    expect(sandboxIdFromHostnameLabel(label?.toUpperCase() ?? '')).toBe(legacySandboxId);
  });

  it('rejects labels without a recognised prefix', () => {
    expect(sandboxIdFromHostnameLabel('abc123')).toBeNull();
    expect(sandboxIdFromHostnameLabel('x-deadbeef')).toBeNull();
    expect(sandboxIdFromHostnameLabel('')).toBeNull();
  });

  it('rejects instance labels with non-hex bodies', () => {
    expect(sandboxIdFromHostnameLabel('i-NOTHEX')).toBeNull();
    expect(sandboxIdFromHostnameLabel('i-550e8400e29b41d4a716446655440000extra')).toBeNull();
    expect(sandboxIdFromHostnameLabel('i-')).toBeNull();
  });

  it('rejects user labels with unsafe characters', () => {
    expect(sandboxIdFromHostnameLabel('u-foo_bar')).toBeNull();
    expect(sandboxIdFromHostnameLabel('u-foo.bar')).toBeNull();
    expect(sandboxIdFromHostnameLabel('u-zzzz')).toBeNull();
    expect(sandboxIdFromHostnameLabel('u-')).toBeNull();
  });
});

const PROD_ENV = {
  KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai',
  KILOCLAW_INSTANCE_URL_SCHEME: 'https',
};

describe('instanceUrl', () => {
  it('throws when the suffix/scheme env vars are missing (no silent fallback)', () => {
    // Scheme is evaluated before suffix in the template literal, so an empty
    // env surfaces the scheme error first.
    expect(() => instanceUrl('i-abc123', {})).toThrow(/KILOCLAW_INSTANCE_URL_SCHEME/);
    expect(() => instanceUrl('i-abc123', { KILOCLAW_INSTANCE_URL_SCHEME: 'https' })).toThrow(
      /KILOCLAW_INSTANCE_HOST_SUFFIX/
    );
    expect(() =>
      instanceUrl('i-abc123', { KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.ai' })
    ).toThrow(/KILOCLAW_INSTANCE_URL_SCHEME/);
    expect(() =>
      instanceUrl('i-abc123', {
        KILOCLAW_INSTANCE_HOST_SUFFIX: '',
        KILOCLAW_INSTANCE_URL_SCHEME: '',
      })
    ).toThrow(/KILOCLAW_INSTANCE_URL_SCHEME/);
  });

  it('composes URL from explicit suffix and scheme', () => {
    expect(instanceUrl('i-abc123', PROD_ENV)).toBe('https://i-abc123.kiloclaw.ai');
    expect(
      instanceUrl('i-abc123', {
        KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.localhost:8795',
        KILOCLAW_INSTANCE_URL_SCHEME: 'http',
      })
    ).toBe('http://i-abc123.kiloclaw.localhost:8795');
  });

  it('roundtrips a sandboxId through hostnameLabelFromSandboxId + instanceUrl', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    const label = hostnameLabelFromSandboxId(sandboxId);
    expect(label).not.toBeNull();
    expect(instanceUrl(label ?? '', PROD_ENV)).toBe(
      'https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai'
    );
  });
});

describe('parseInstanceHost', () => {
  it('throws when the suffix env var is missing (no silent fallback)', () => {
    expect(() => parseInstanceHost('i-abc.kiloclaw.ai', {})).toThrow(
      /KILOCLAW_INSTANCE_HOST_SUFFIX/
    );
  });

  it('returns the label for a matching host', () => {
    expect(parseInstanceHost('i-abc123.kiloclaw.ai', PROD_ENV)).toBe('i-abc123');
    expect(parseInstanceHost('u-deadbeef.kiloclaw.ai', PROD_ENV)).toBe('u-deadbeef');
  });

  it('is case-insensitive and lowercases the returned label', () => {
    expect(parseInstanceHost('I-ABC123.KILOCLAW.AI', PROD_ENV)).toBe('i-abc123');
    expect(parseInstanceHost('I-ABC123.KiloClaw.Ai', PROD_ENV)).toBe('i-abc123');
  });

  it('returns null when the host does not end with the suffix', () => {
    expect(parseInstanceHost('claw.kilosessions.ai', PROD_ENV)).toBeNull();
    expect(parseInstanceHost('localhost:8795', PROD_ENV)).toBeNull();
    expect(parseInstanceHost('marketing.kiloclaw.com', PROD_ENV)).toBeNull();
  });

  it('rejects bare suffix with no label', () => {
    expect(parseInstanceHost('.kiloclaw.ai', PROD_ENV)).toBeNull();
    expect(parseInstanceHost('kiloclaw.ai', PROD_ENV)).toBeNull();
  });

  it('rejects multi-label subdomains', () => {
    expect(parseInstanceHost('foo.bar.kiloclaw.ai', PROD_ENV)).toBeNull();
    expect(parseInstanceHost('a.b.c.kiloclaw.ai', PROD_ENV)).toBeNull();
  });

  it('works with a dev suffix including a port', () => {
    const env = {
      KILOCLAW_INSTANCE_HOST_SUFFIX: '.kiloclaw.localhost:8795',
      KILOCLAW_INSTANCE_URL_SCHEME: 'http',
    };
    expect(parseInstanceHost('i-abc.kiloclaw.localhost:8795', env)).toBe('i-abc');
    expect(parseInstanceHost('I-ABC.KILOCLAW.LOCALHOST:8795', env)).toBe('i-abc');
    // Host without the port component doesn't match the port-bearing suffix.
    expect(parseInstanceHost('i-abc.kiloclaw.localhost', env)).toBeNull();
    // Suffix-less host stays unmatched.
    expect(parseInstanceHost('localhost:8795', env)).toBeNull();
  });
});
