import { describe, it, expect } from 'vitest';
import { sandboxIdFromUserId, userIdFromSandboxId } from './sandbox-id';

describe('sandboxIdFromUserId', () => {
  it('encodes a simple userId', () => {
    const sandboxId = sandboxIdFromUserId('user_abc123');
    expect(sandboxId).toBe('dXNlcl9hYmMxMjM');
  });

  it('roundtrips a simple userId', () => {
    const userId = 'user_abc123';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('roundtrips a userId with slashes and colons', () => {
    const userId = 'oauth/google:118234567890';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('roundtrips a UUID userId', () => {
    const userId = '550e8400-e29b-41d4-a716-446655440000';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
    // UUID (36 chars) -> 48 chars encoded, under 63 limit
    expect(sandboxId.length).toBeLessThanOrEqual(63);
  });

  it('roundtrips an email-like userId', () => {
    const userId = 'user@example.com';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('roundtrips a userId with + character', () => {
    const userId = 'user+tag@example.com';
    const sandboxId = sandboxIdFromUserId(userId);
    // sandboxId should use - instead of + (base64url)
    expect(sandboxId).not.toContain('+');
    expect(sandboxId).not.toContain('/');
    expect(sandboxId).not.toContain('=');
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('throws for overly long userId', () => {
    // 48 bytes of userId -> 64 chars encoded, over the 63-char limit
    const longUserId = 'a'.repeat(48);
    expect(() => sandboxIdFromUserId(longUserId)).toThrow('userId too long');
  });

  it('accepts maximum-length userId (47 bytes)', () => {
    const maxUserId = 'a'.repeat(47);
    const sandboxId = sandboxIdFromUserId(maxUserId);
    expect(sandboxId.length).toBeLessThanOrEqual(63);
    expect(userIdFromSandboxId(sandboxId)).toBe(maxUserId);
  });

  it('produces URL-safe output', () => {
    // Use a userId that would produce +, /, = in standard base64
    const userId = '>>>???';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(sandboxId).not.toContain('+');
    expect(sandboxId).not.toContain('/');
    expect(sandboxId).not.toContain('=');
  });

  it('roundtrips a Unicode userId without throwing', () => {
    const userId = 'ユーザー@例.jp';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });
});
