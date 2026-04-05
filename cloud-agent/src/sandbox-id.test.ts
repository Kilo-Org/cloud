import { describe, expect, it } from 'vitest';
import { generateSandboxId } from './sandbox-id.js';

describe('generateSandboxId', () => {
  describe('length validation', () => {
    it('should generate sandboxId within 63 character limit', async () => {
      const sandboxId = await generateSandboxId(
        '9d278969-5453-4ae3-a51f-a8d2274a7b56',
        'fd93a81c-63c2-4d14-84b3-60d6ac3b592f'
      );
      expect(sandboxId.length).toBeLessThanOrEqual(63);
      expect(sandboxId.length).toBe(52); // Exact expected length
    });

    it('should handle long inputs without exceeding limit', async () => {
      const longOrgId = 'a'.repeat(36);
      const longUserId = 'b'.repeat(36);
      const longBotId = 'c'.repeat(50);

      const sandboxId = await generateSandboxId(longOrgId, longUserId, longBotId);
      expect(sandboxId.length).toBe(52);
    });
  });

  describe('determinism', () => {
    it('should generate same sandboxId for same inputs', async () => {
      const orgId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
      const userId = 'fd93a81c-63c2-4d14-84b3-60d6ac3b592f';

      const id1 = await generateSandboxId(orgId, userId);
      const id2 = await generateSandboxId(orgId, userId);

      expect(id1).toBe(id2);
    });

    it('should be deterministic with botId', async () => {
      const orgId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
      const userId = 'fd93a81c-63c2-4d14-84b3-60d6ac3b592f';
      const botId = 'reviewer';

      const id1 = await generateSandboxId(orgId, userId, botId);
      const id2 = await generateSandboxId(orgId, userId, botId);

      expect(id1).toBe(id2);
    });
  });

  describe('prefix correctness', () => {
    it('should use "org" prefix for organization accounts', async () => {
      const sandboxId = await generateSandboxId('org-id', 'user-id');
      expect(sandboxId).toMatch(/^org-[0-9a-f]{48}$/);
    });

    it('should use "usr" prefix for personal accounts', async () => {
      const sandboxId = await generateSandboxId(undefined, 'user-id');
      expect(sandboxId).toMatch(/^usr-[0-9a-f]{48}$/);
    });

    it('should use "bot" prefix for org accounts with bot', async () => {
      const sandboxId = await generateSandboxId('org-id', 'user-id', 'reviewer');
      expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
    });

    it('should use "ubt" prefix for personal accounts with bot', async () => {
      const sandboxId = await generateSandboxId(undefined, 'user-id', 'reviewer');
      expect(sandboxId).toMatch(/^ubt-[0-9a-f]{48}$/);
    });
  });

  describe('uniqueness', () => {
    it('should generate different IDs for different orgIds', async () => {
      const id1 = await generateSandboxId('org-1', 'user-id');
      const id2 = await generateSandboxId('org-2', 'user-id');
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different userIds', async () => {
      const id1 = await generateSandboxId('org-id', 'user-1');
      const id2 = await generateSandboxId('org-id', 'user-2');
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different botIds', async () => {
      const id1 = await generateSandboxId('org-id', 'user-id', 'bot-1');
      const id2 = await generateSandboxId('org-id', 'user-id', 'bot-2');
      expect(id1).not.toBe(id2);
    });

    it('should differ between org and personal accounts', async () => {
      const userId = 'user-id';
      const orgId = await generateSandboxId('org-id', userId);
      const personal = await generateSandboxId(undefined, userId);
      expect(orgId).not.toBe(personal);
    });

    it('should differ with and without bot', async () => {
      const withoutBot = await generateSandboxId('org-id', 'user-id');
      const withBot = await generateSandboxId('org-id', 'user-id', 'reviewer');
      expect(withoutBot).not.toBe(withBot);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in IDs', async () => {
      const sandboxId = await generateSandboxId('org@123', 'user#456', 'bot$789');
      expect(sandboxId.length).toBe(52);
      expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
    });

    it('should handle empty strings', async () => {
      const sandboxId = await generateSandboxId('', '', '');
      expect(sandboxId.length).toBe(52);
    });

    it('should handle unicode characters', async () => {
      const sandboxId = await generateSandboxId('org-日本', 'user-한국', 'bot-中国');
      expect(sandboxId.length).toBe(52);
    });
  });
});
