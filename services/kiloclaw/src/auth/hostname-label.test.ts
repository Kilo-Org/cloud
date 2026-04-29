import { describe, it, expect } from 'vitest';
import { sandboxIdFromUserId } from './sandbox-id';
import { sandboxIdFromInstanceId } from '@kilocode/worker-utils/instance-id';
import {
  hostnameLabelFromSandboxId,
  sandboxIdFromHostnameLabel,
  MAX_HOSTNAME_LABEL_LENGTH,
} from './hostname-label';

describe('hostnameLabelFromSandboxId', () => {
  it('maps an instance-keyed sandboxId to `i-{32hex}`', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(sandboxId).toBe('ki_550e8400e29b41d4a716446655440000');

    expect(hostnameLabelFromSandboxId(sandboxId)).toBe('i-550e8400e29b41d4a716446655440000');
  });

  it('maps a legacy UUID userId sandboxId to `u-{base64url}`', () => {
    const sandboxId = sandboxIdFromUserId('550e8400-e29b-41d4-a716-446655440000');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(label?.startsWith('u-')).toBe(true);
    expect(label).toMatch(/^u-[A-Za-z0-9]+$/);
  });

  it('maps a legacy oauth-provider userId sandboxId to a safe label', () => {
    const sandboxId = sandboxIdFromUserId('oauth/google:118234567890');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(label).toMatch(/^u-[A-Za-z0-9]+$/);
  });

  it('maps a legacy email-shaped userId sandboxId to a safe label', () => {
    const sandboxId = sandboxIdFromUserId('user+tag@example.com');
    const label = hostnameLabelFromSandboxId(sandboxId);

    expect(label).not.toBeNull();
    expect(label).toMatch(/^u-[A-Za-z0-9]+$/);
  });

  it('returns null when the legacy sandboxId contains base64url `-` or `_`', () => {
    // `>` (0x3E) at byte position 2 / 5 / … in a userId produces a `-` in the
    // base64url encoding (group-3 value = 62). `?` (0x3F) at the same
    // positions produces a `_`. Neither appears in production userIds but
    // we must not emit them in a hostname label (would violate strict RFC 1035
    // and trip some TLS/DNS stacks). Caller should skip origin injection.
    const sandboxIdWithDash = sandboxIdFromUserId('ab>');
    expect(sandboxIdWithDash).toMatch(/-/);
    expect(hostnameLabelFromSandboxId(sandboxIdWithDash)).toBeNull();

    const sandboxIdWithUnderscore = sandboxIdFromUserId('ab?');
    expect(sandboxIdWithUnderscore).toMatch(/_/);
    expect(hostnameLabelFromSandboxId(sandboxIdWithUnderscore)).toBeNull();
  });

  it('returns null when the label would exceed the DNS label length', () => {
    // 62-char alnum sandboxId + `u-` = 64, over the 63-char limit.
    const overlongSandboxId = 'a'.repeat(62);
    expect(hostnameLabelFromSandboxId(overlongSandboxId)).toBeNull();

    const atLimitSandboxId = 'a'.repeat(61);
    const label = hostnameLabelFromSandboxId(atLimitSandboxId);
    expect(label).toBe(`u-${atLimitSandboxId}`);
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
    expect(sandboxIdFromHostnameLabel('u-')).toBeNull();
  });
});
