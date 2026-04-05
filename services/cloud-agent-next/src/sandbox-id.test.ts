import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import { generateSandboxId, getSandboxNamespace } from './sandbox-id.js';
import type { Env } from './types.js';

describe('generateSandboxId', () => {
  describe('shared sandbox (default)', () => {
    it('should generate sandboxId within 63 character limit', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        '9d278969-5453-4ae3-a51f-a8d2274a7b56',
        'fd93a81c-63c2-4d14-84b3-60d6ac3b592f',
        'agent_session-1'
      );
      expect(sandboxId.length).toBeLessThanOrEqual(63);
      expect(sandboxId.length).toBe(52);
    });

    it('should handle long inputs without exceeding limit', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        'a'.repeat(36),
        'b'.repeat(36),
        'agent_session-1',
        'c'.repeat(50)
      );
      expect(sandboxId.length).toBe(52);
    });

    it('should generate same sandboxId for same inputs', async () => {
      const args = [
        undefined,
        '9d278969-5453-4ae3-a51f-a8d2274a7b56',
        'fd93a81c-63c2-4d14-84b3-60d6ac3b592f',
        'agent_session-1',
      ] as const;
      expect(await generateSandboxId(...args)).toBe(await generateSandboxId(...args));
    });

    it('should be deterministic with botId', async () => {
      const args = [
        undefined,
        '9d278969-5453-4ae3-a51f-a8d2274a7b56',
        'fd93a81c-63c2-4d14-84b3-60d6ac3b592f',
        'agent_session-1',
        'reviewer',
      ] as const;
      expect(await generateSandboxId(...args)).toBe(await generateSandboxId(...args));
    });

    it('should produce the same shared ID for different sessionIds', async () => {
      const id1 = await generateSandboxId(undefined, 'org-id', 'user-id', 'session-a');
      const id2 = await generateSandboxId(undefined, 'org-id', 'user-id', 'session-b');
      expect(id1).toBe(id2);
    });
  });

  describe('prefix correctness', () => {
    it('should use "org" prefix for organization accounts', async () => {
      const sandboxId = await generateSandboxId(undefined, 'org-id', 'user-id', 's');
      expect(sandboxId).toMatch(/^org-[0-9a-f]{48}$/);
    });

    it('should use "usr" prefix for personal accounts', async () => {
      const sandboxId = await generateSandboxId(undefined, undefined, 'user-id', 's');
      expect(sandboxId).toMatch(/^usr-[0-9a-f]{48}$/);
    });

    it('should use "bot" prefix for org accounts with bot', async () => {
      const sandboxId = await generateSandboxId(undefined, 'org-id', 'user-id', 's', 'reviewer');
      expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
    });

    it('should use "ubt" prefix for personal accounts with bot', async () => {
      const sandboxId = await generateSandboxId(undefined, undefined, 'user-id', 's', 'reviewer');
      expect(sandboxId).toMatch(/^ubt-[0-9a-f]{48}$/);
    });
  });

  describe('uniqueness', () => {
    it('should generate different IDs for different orgIds', async () => {
      const id1 = await generateSandboxId(undefined, 'org-1', 'user-id', 's');
      const id2 = await generateSandboxId(undefined, 'org-2', 'user-id', 's');
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different userIds', async () => {
      const id1 = await generateSandboxId(undefined, 'org-id', 'user-1', 's');
      const id2 = await generateSandboxId(undefined, 'org-id', 'user-2', 's');
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different botIds', async () => {
      const id1 = await generateSandboxId(undefined, 'org-id', 'user-id', 's', 'bot-1');
      const id2 = await generateSandboxId(undefined, 'org-id', 'user-id', 's', 'bot-2');
      expect(id1).not.toBe(id2);
    });

    it('should differ between org and personal accounts', async () => {
      const orgId = await generateSandboxId(undefined, 'org-id', 'user-id', 's');
      const personal = await generateSandboxId(undefined, undefined, 'user-id', 's');
      expect(orgId).not.toBe(personal);
    });

    it('should differ with and without bot', async () => {
      const withoutBot = await generateSandboxId(undefined, 'org-id', 'user-id', 's');
      const withBot = await generateSandboxId(undefined, 'org-id', 'user-id', 's', 'reviewer');
      expect(withoutBot).not.toBe(withBot);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in IDs', async () => {
      const sandboxId = await generateSandboxId(undefined, 'org@123', 'user#456', 's', 'bot$789');
      expect(sandboxId.length).toBe(52);
      expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
    });

    it('should handle empty strings', async () => {
      const sandboxId = await generateSandboxId(undefined, '', '', '', '');
      expect(sandboxId.length).toBe(52);
    });

    it('should handle unicode characters', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        'org-日本',
        'user-한국',
        's',
        'bot-中国'
      );
      expect(sandboxId.length).toBe(52);
    });
  });

  describe('per-session sandbox', () => {
    it('should produce a ses- prefixed ID for a per-session org', async () => {
      const id = await generateSandboxId('my-org', 'my-org', 'user-id', 'agent_abc123');
      expect(id).toMatch(/^ses-[0-9a-f]{48}$/);
    });

    it('should be exactly 52 characters', async () => {
      const id = await generateSandboxId('my-org', 'my-org', 'user-id', 'agent_abc123');
      expect(id.length).toBe(52);
    });

    it('should be deterministic for the same session ID', async () => {
      const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
      const id1 = await generateSandboxId('org', 'org', 'user', sessionId);
      const id2 = await generateSandboxId('org', 'org', 'user', sessionId);
      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different session IDs', async () => {
      const id1 = await generateSandboxId('org', 'org', 'user', 'session-a');
      const id2 = await generateSandboxId('org', 'org', 'user', 'session-b');
      expect(id1).not.toBe(id2);
    });

    it('should match on any entry in the comma-separated list', async () => {
      const id = await generateSandboxId('org-a, org-b', 'org-b', 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('should trim whitespace around entries', async () => {
      const id = await generateSandboxId(' org-a , org-b ', 'org-a', 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('should fall back to shared when perSessionOrgIds is empty', async () => {
      const id = await generateSandboxId('', 'org', 'user', 'session');
      expect(id).toMatch(/^org-/);
    });

    it('should fall back to shared when perSessionOrgIds is undefined', async () => {
      const id = await generateSandboxId(undefined, 'org', 'user', 'session');
      expect(id).toMatch(/^org-/);
    });

    it('should fall back to shared for orgs not in the list', async () => {
      const id = await generateSandboxId('other-org', 'org', 'user', 'session');
      expect(id).toMatch(/^org-/);
    });

    it('should fall back to shared when orgId is undefined', async () => {
      const id = await generateSandboxId('anything', undefined, 'user', 'session');
      expect(id).toMatch(/^usr-/);
    });

    it('should treat "*" as wildcard matching any org', async () => {
      const id = await generateSandboxId('*', 'any-org', 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('should use per-session sandbox with "*" even when orgId is undefined', async () => {
      const id = await generateSandboxId('*', undefined, 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });
  });
});

describe('getSandboxNamespace', () => {
  const mockSandbox = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxSmall = {} as DurableObjectNamespace<Sandbox>;
  const mockEnv = {
    Sandbox: mockSandbox,
    SandboxSmall: mockSandboxSmall,
  } as unknown as Env;

  it('should return SandboxSmall for ses- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandboxSmall);
  });

  it('should return Sandbox for org- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'org-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
  });

  it('should return Sandbox for usr- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'usr-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
  });

  it('should return Sandbox for bot- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'bot-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
  });
});
