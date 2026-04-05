/**
 * Adversarial Input Tests for Tenant Isolation
 *
 * Security assessment: Phase 2 — Tenant Isolation Validation
 * Tests sandboxIdFromUserId() and appNameFromUserId() with adversarial inputs
 * to verify no collisions, no crashes, and correct isolation under edge cases.
 *
 * Covers: Unicode, null bytes, control characters, injection payloads,
 * boundary lengths, collision resistance, SHA-256 truncation, BOM handling.
 *
 * Finding TI-1: TextDecoder strips leading BOM in userIdFromSandboxId().
 * See: findings-and-reviews/tenant-isolation-adversarial-testing.md
 */

import { describe, it, expect } from 'vitest';
import { sandboxIdFromUserId, userIdFromSandboxId } from './sandbox-id';
import { appNameFromUserId } from '../fly/apps';

// =============================================================================
// sandboxIdFromUserId — Adversarial Inputs
// =============================================================================

describe('sandboxIdFromUserId — adversarial inputs', () => {
  // -- Unicode edge cases --

  it('handles CJK characters (multi-byte UTF-8)', () => {
    const userId = '用户名测试';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('handles emoji in userId', () => {
    const userId = 'user-🔒-admin';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('handles mixed scripts (Latin + Arabic + CJK)', () => {
    const userId = 'user-عربي-中文';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('handles zero-width characters', () => {
    const userId = 'user\u200B\u200C\u200Dname'; // ZWS, ZWNJ, ZWJ
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('distinguishes userIds that differ only by zero-width chars', () => {
    const userId1 = 'username';
    const userId2 = 'user\u200Bname'; // with zero-width space
    const sandbox1 = sandboxIdFromUserId(userId1);
    const sandbox2 = sandboxIdFromUserId(userId2);
    expect(sandbox1).not.toBe(sandbox2);
  });

  it('handles combining characters / diacritics', () => {
    // é as precomposed vs decomposed
    const precomposed = 'caf\u00E9'; // é (single codepoint)
    const decomposed = 'cafe\u0301'; // e + combining acute accent
    const sandbox1 = sandboxIdFromUserId(precomposed);
    const sandbox2 = sandboxIdFromUserId(decomposed);
    // These are different byte sequences, so they SHOULD produce different sandboxIds
    expect(sandbox1).not.toBe(sandbox2);
    // Both should roundtrip correctly
    expect(userIdFromSandboxId(sandbox1)).toBe(precomposed);
    expect(userIdFromSandboxId(sandbox2)).toBe(decomposed);
  });

  it('handles RTL override characters', () => {
    const userId = 'user\u202Ename\u202C'; // RLO + PDF
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  // -- Boundary lengths --

  it('rejects userId of 48 ASCII bytes (1 over limit)', () => {
    expect(() => sandboxIdFromUserId('a'.repeat(48))).toThrow('userId too long');
  });

  it('accepts userId of 47 ASCII bytes (at limit)', () => {
    const userId = 'a'.repeat(47);
    const sandboxId = sandboxIdFromUserId(userId);
    expect(sandboxId.length).toBeLessThanOrEqual(63);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('rejects short Unicode userId that expands beyond 63 chars in base64', () => {
    // Each CJK char = 3 bytes UTF-8, so 16 CJK chars = 48 bytes = 64 base64 chars
    const userId = '中'.repeat(16);
    expect(() => sandboxIdFromUserId(userId)).toThrow('userId too long');
  });

  it('accepts Unicode userId just under the base64 limit', () => {
    // 15 CJK chars = 45 bytes = 60 base64 chars (under 63)
    const userId = '中'.repeat(15);
    const sandboxId = sandboxIdFromUserId(userId);
    expect(sandboxId.length).toBeLessThanOrEqual(63);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('handles 4-byte emoji that push over the limit', () => {
    // Each emoji = 4 bytes UTF-8, so 12 emojis = 48 bytes = 64 base64 chars
    const userId = '🔒'.repeat(12);
    expect(() => sandboxIdFromUserId(userId)).toThrow('userId too long');
  });

  // -- Special characters and injection attempts --

  it('handles null bytes in userId', () => {
    const userId = 'user\x00name';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('distinguishes userIds with and without null bytes', () => {
    const userId1 = 'username';
    const userId2 = 'user\x00name';
    const sandbox1 = sandboxIdFromUserId(userId1);
    const sandbox2 = sandboxIdFromUserId(userId2);
    expect(sandbox1).not.toBe(sandbox2);
  });

  it('handles newlines and tabs', () => {
    const userId = 'user\n\r\tname';
    const sandboxId = sandboxIdFromUserId(userId);
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('handles path traversal attempts', () => {
    const userId = '../../../etc/passwd';
    const sandboxId = sandboxIdFromUserId(userId);
    // Should encode safely — no raw path chars in output
    expect(sandboxId).not.toContain('/');
    expect(sandboxId).not.toContain('..');
    expect(userIdFromSandboxId(sandboxId)).toBe(userId);
  });

  it('handles empty string userId', () => {
    const sandboxId = sandboxIdFromUserId('');
    expect(sandboxId).toBe('');
    expect(userIdFromSandboxId(sandboxId)).toBe('');
  });

  it('handles single character userId', () => {
    const sandboxId = sandboxIdFromUserId('a');
    expect(userIdFromSandboxId(sandboxId)).toBe('a');
  });

  it('output contains only base64url-safe characters', () => {
    const adversarialInputs = [
      'user+tag@example.com',
      '>>>???<<<',
      'user/admin/root',
      'key=value&foo=bar',
      'SELECT * FROM users',
      '<script>alert(1)</script>',
      'user\x00\x01\x02\x03',
    ];
    for (const userId of adversarialInputs) {
      const sandboxId = sandboxIdFromUserId(userId);
      expect(sandboxId, `Failed for input: ${userId}`).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  // -- Collision resistance (bijective encoding) --

  it('never produces collisions across diverse inputs', () => {
    const inputs = [
      'user-1',
      'user-2',
      'User-1', // case difference
      'user-1 ', // trailing space
      ' user-1', // leading space
      'user\x001', // null byte before 1
      'user-١', // Arabic numeral 1
      'user-1\u200B', // with zero-width space
    ];
    const sandboxIds = inputs.map(id => sandboxIdFromUserId(id));
    const unique = new Set(sandboxIds);
    expect(unique.size).toBe(sandboxIds.length);
  });

  // -- BOM edge case (FINDING: TI-1) --

  it('TI-1: BOM-prefixed userId roundtrips correctly (fixed)', () => {
    // Previously TextDecoder stripped U+FEFF (BOM) from decoded output.
    // Fixed by using TextDecoder('utf-8', { ignoreBOM: true }).
    const userId = '\uFEFFadmin';
    const sandboxId = sandboxIdFromUserId(userId);
    const recovered = userIdFromSandboxId(sandboxId);

    // BOM is preserved on roundtrip
    expect(recovered).toBe(userId);

    // Forward direction is collision-free
    const sandboxPlain = sandboxIdFromUserId('admin');
    expect(sandboxId).not.toBe(sandboxPlain);
  });
});

// =============================================================================
// appNameFromUserId — Adversarial Inputs
// =============================================================================

describe('appNameFromUserId — adversarial inputs', () => {
  const adversarialUserIds = [
    '', // empty string
    'a', // single char
    'a'.repeat(1000), // very long
    'a'.repeat(10000), // extremely long
    'user\x00name', // null byte
    'user\n\r\tname', // control chars
    '../../../etc/passwd', // path traversal
    'user-🔒-admin', // emoji
    '用户名测试', // CJK
    'user-عربي', // Arabic
    'user\u200B\u200C\u200Dname', // zero-width chars
    'caf\u00E9', // precomposed
    'cafe\u0301', // decomposed
    'SELECT * FROM users; DROP TABLE--', // SQL injection
    '<script>alert(1)</script>', // XSS
    '${process.env.SECRET}', // template injection
    'user\x00\x01\x02\x03\x04\x05', // low control chars
    'user'.repeat(500), // repetitive pattern
  ];

  // -- Format invariants --

  it('always produces valid acct-{20 hex} format regardless of input', async () => {
    for (const userId of adversarialUserIds) {
      const name = await appNameFromUserId(userId);
      expect(name, `Failed format for input: ${JSON.stringify(userId)}`).toMatch(
        /^acct-[0-9a-f]{20}$/
      );
    }
  });

  it('always produces exactly 25 characters regardless of input', async () => {
    for (const userId of adversarialUserIds) {
      const name = await appNameFromUserId(userId);
      expect(name.length, `Wrong length for input: ${JSON.stringify(userId)}`).toBe(25);
    }
  });

  it('is deterministic for all adversarial inputs', async () => {
    for (const userId of adversarialUserIds) {
      const name1 = await appNameFromUserId(userId);
      const name2 = await appNameFromUserId(userId);
      expect(name1, `Non-deterministic for input: ${JSON.stringify(userId)}`).toBe(name2);
    }
  });

  // -- Collision resistance --

  it('produces no collisions across all adversarial inputs', async () => {
    const names = await Promise.all(adversarialUserIds.map(id => appNameFromUserId(id)));
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('distinguishes case-sensitive userIds', async () => {
    const lower = await appNameFromUserId('user-abc');
    const upper = await appNameFromUserId('User-ABC');
    const mixed = await appNameFromUserId('User-Abc');
    expect(new Set([lower, upper, mixed]).size).toBe(3);
  });

  it('distinguishes userIds differing only by whitespace', async () => {
    const plain = await appNameFromUserId('username');
    const leading = await appNameFromUserId(' username');
    const trailing = await appNameFromUserId('username ');
    const inner = await appNameFromUserId('user name');
    expect(new Set([plain, leading, trailing, inner]).size).toBe(4);
  });

  it('distinguishes precomposed vs decomposed Unicode', async () => {
    const precomposed = await appNameFromUserId('caf\u00E9');
    const decomposed = await appNameFromUserId('cafe\u0301');
    expect(precomposed).not.toBe(decomposed);
  });

  it('distinguishes userIds differing only by zero-width chars', async () => {
    const plain = await appNameFromUserId('username');
    const zwsp = await appNameFromUserId('user\u200Bname');
    const zwnj = await appNameFromUserId('user\u200Cname');
    const zwj = await appNameFromUserId('user\u200Dname');
    expect(new Set([plain, zwsp, zwnj, zwj]).size).toBe(4);
  });

  it('distinguishes userIds differing only by null bytes', async () => {
    const plain = await appNameFromUserId('username');
    const nulled = await appNameFromUserId('user\x00name');
    expect(plain).not.toBe(nulled);
  });

  // -- SHA-256 truncation edge cases --

  it('produces unique names for 100 sequential user-N inputs', async () => {
    const names = await Promise.all(
      Array.from({ length: 100 }, (_, i) => appNameFromUserId(`user-${i}`))
    );
    const unique = new Set(names);
    expect(unique.size).toBe(100);
  });

  it('produces unique names for 1000 sequential numeric inputs', async () => {
    const names = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => appNameFromUserId(`${i}`))
    );
    const unique = new Set(names);
    expect(unique.size).toBe(1000);
  });

  // -- Cross-function consistency --

  it('sandboxId and appName both handle the same adversarial inputs without crashing', async () => {
    const safeInputs = adversarialUserIds.filter(id => {
      try {
        sandboxIdFromUserId(id);
        return true;
      } catch {
        return false; // skip inputs that are too long for sandboxId
      }
    });

    for (const userId of safeInputs) {
      const sandboxId = sandboxIdFromUserId(userId);
      const appName = await appNameFromUserId(userId);

      expect(userIdFromSandboxId(sandboxId)).toBe(userId);
      expect(appName).toMatch(/^acct-[0-9a-f]{20}$/);
    }
  });

  // -- BOM isolation check (FINDING: TI-1) --

  it('TI-1: BOM userId and plain userId produce different appNames (isolation preserved)', async () => {
    const bomApp = await appNameFromUserId('\uFEFFadmin');
    const plainApp = await appNameFromUserId('admin');
    expect(bomApp).not.toBe(plainApp);
  });

  // -- URL safety --

  it('appName is safe for Fly API URL paths', async () => {
    const dangerousInputs = [
      'user/../../admin',
      'user?query=1',
      'user#fragment',
      'user%00name',
      'user\x00name',
    ];
    for (const userId of dangerousInputs) {
      const name = await appNameFromUserId(userId);
      // acct-{hex} format implicitly excludes all URL-dangerous characters
      expect(name).toMatch(/^acct-[0-9a-f]{20}$/);
    }
  });
});
