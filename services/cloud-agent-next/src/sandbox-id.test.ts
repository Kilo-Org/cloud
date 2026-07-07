import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  deriveSharedSandboxId,
  generateSandboxId,
  generateSandboxRoutingTarget,
  getOutboundContainerId,
  getSandboxNamespace,
  isOrgInList,
} from './sandbox-id.js';
import type { Env, SandboxId } from './types.js';

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

    it.each([
      [
        'org',
        'org-id',
        undefined,
        'org-3dd951780cb3512874a8a3862ca0389e1c13494a677607a3',
        'org-4bec79d08eabcf42eaa2a388124758cd2d61ba5273685ec9',
      ],
      [
        'usr',
        undefined,
        undefined,
        'usr-1ff364644f8c9e3b000eb3411592d4b6d15bb7a46da5c3d4',
        'usr-bcbe81d943836000fb88aa07b983850e549b0fee3d0bfc64',
      ],
      [
        'bot',
        'org-id',
        'reviewer',
        'bot-f404d7b8471e6abcfd94351ceaa066b7a7e83f75c14ad202',
        'bot-0a14d4c299e776b24151a12725aa1c9b36c60390af40ce65',
      ],
      [
        'ubt',
        undefined,
        'reviewer',
        'ubt-4ac50a2a29586ee24f93bd742afd37224b0cb153c25f52e0',
        'ubt-e1d1603733e277a3bfdaab2faa6fcd3b0602056168b56ca7',
      ],
    ])(
      'provides stable base and suffixed IDs for %s shared sandboxes',
      async (_prefix, orgId, botId, routeKey, failoverSandboxId) => {
        const target = await generateSandboxRoutingTarget(
          undefined,
          orgId,
          'user-id',
          'session-a',
          botId
        );

        expect(target).toEqual({
          kind: 'shared',
          routeKey,
        });
        await expect(deriveSharedSandboxId(routeKey as SandboxId, 'shared-slot-v1')).resolves.toBe(
          failoverSandboxId
        );
        expect(target).toEqual(
          await generateSandboxRoutingTarget(undefined, orgId, 'user-id', 'session-b', botId)
        );
      }
    );

    it.each([
      [
        'org',
        'org-id',
        undefined,
        'org-3dd951780cb3512874a8a3862ca0389e1c13494a677607a3',
        'org-7d891a9e4905bb0d5ff8dffcb99ba76973039c70340665b0',
      ],
      [
        'usr',
        undefined,
        undefined,
        'usr-1ff364644f8c9e3b000eb3411592d4b6d15bb7a46da5c3d4',
        'usr-e4da69a737a38f1fc3283e8159b965e9d88f13d84c23cab1',
      ],
      [
        'bot',
        'org-id',
        'reviewer',
        'bot-f404d7b8471e6abcfd94351ceaa066b7a7e83f75c14ad202',
        'bot-b7b5ae452e738ff4c3e88238a0bd903edb1039b22314e3dc',
      ],
      [
        'ubt',
        undefined,
        'reviewer',
        'ubt-4ac50a2a29586ee24f93bd742afd37224b0cb153c25f52e0',
        'ubt-5714320d8e828e8d428046c7f8601c126755f3e04d55b0d6',
      ],
    ])(
      'should use the current shared sandbox ID generation for %s IDs',
      async (_prefix, orgId, botId, expectedId, previousId) => {
        const id = await generateSandboxId(undefined, orgId, 'user-id', 'session', botId);

        expect(id).toBe(expectedId);
        expect(id).not.toBe(previousId);
      }
    );
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
    it('bypasses shared slot routing', async () => {
      await expect(
        generateSandboxRoutingTarget('my-org', 'my-org', 'user-id', 'agent_abc123')
      ).resolves.toEqual({
        kind: 'isolated',
        sandboxId: 'ses-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370',
      });
    });

    it('should preserve the existing per-session ID generation', async () => {
      const id = await generateSandboxId('my-org', 'my-org', 'user-id', 'agent_abc123');
      expect(id).toBe('ses-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
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

  describe('devcontainer sandbox', () => {
    it('bypasses shared slot routing', async () => {
      await expect(
        generateSandboxRoutingTarget(
          undefined,
          'org-id',
          'user-id',
          'agent_abc123',
          undefined,
          true
        )
      ).resolves.toEqual({
        kind: 'isolated',
        sandboxId: 'dind-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370',
      });
    });

    it('should preserve the existing devcontainer ID generation', async () => {
      const id = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        'agent_abc123',
        undefined,
        true
      );
      expect(id).toBe('dind-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
    });

    it('should be exactly 53 characters', async () => {
      const id = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        'agent_abc123',
        undefined,
        true
      );
      expect(id.length).toBe(53);
    });

    it('should be deterministic for the same session ID', async () => {
      const id1 = await generateSandboxId(undefined, 'org', 'user', 'session', undefined, true);
      const id2 = await generateSandboxId(undefined, 'org', 'user', 'session', undefined, true);
      expect(id1).toBe(id2);
    });

    it('should take precedence over per-session routing', async () => {
      const id = await generateSandboxId('*', 'org', 'user', 'session', undefined, true);
      expect(id).toMatch(/^dind-/);
    });

    it('should not produce dind- prefix when devcontainer is false', async () => {
      const id = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        'session',
        undefined,
        false
      );
      expect(id).toMatch(/^org-/);
    });

    it('should not produce dind- prefix when devcontainer is undefined', async () => {
      const id = await generateSandboxId(undefined, 'org-id', 'user-id', 'session');
      expect(id).toMatch(/^org-/);
    });
  });

  describe('Code Reviewer ephemeral sandbox', () => {
    it('routes Code Reviewer sessions to dedicated crv sandboxes', async () => {
      const target = await generateSandboxRoutingTarget(
        undefined,
        'org-review',
        'user-id',
        'agent_abc123',
        undefined,
        {
          createdOnPlatform: 'code-review',
        }
      );

      expect(target).toEqual({
        kind: 'isolated',
        sandboxId: 'crv-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370',
      });
    });

    it('routes orgless Code Reviewer sessions to dedicated crv sandboxes', async () => {
      await expect(
        generateSandboxRoutingTarget(undefined, undefined, 'user-id', 'agent_abc123', undefined, {
          createdOnPlatform: 'code-review',
        })
      ).resolves.toEqual({
        kind: 'isolated',
        sandboxId: 'crv-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370',
      });
    });

    it('lets devcontainer routing take precedence over Code Reviewer ephemeral routing', async () => {
      const id = await generateSandboxId(
        undefined,
        'org-review',
        'user-id',
        'agent_abc123',
        undefined,
        {
          devcontainer: true,
          createdOnPlatform: 'code-review',
        }
      );

      expect(id).toBe('dind-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
    });
  });
});

describe('getSandboxNamespace', () => {
  const mockSandbox = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxContainment = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxSmall = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxSmallContainment = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxDIND = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxCodeReview = {} as DurableObjectNamespace<Sandbox>;
  const mockSandboxCodeReviewContainment = {} as DurableObjectNamespace<Sandbox>;
  const mockEnv = {
    Sandbox: mockSandbox,
    SandboxContainment: mockSandboxContainment,
    SandboxSmall: mockSandboxSmall,
    SandboxSmallContainment: mockSandboxSmallContainment,
    SandboxDIND: mockSandboxDIND,
    SandboxCodeReview: mockSandboxCodeReview,
    SandboxCodeReviewContainment: mockSandboxCodeReviewContainment,
  } as unknown as Env;

  it('should return SandboxDIND for dind- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'dind-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'
    );
    expect(ns).toBe(mockSandboxDIND);
  });

  it('should return SandboxSmall for ses- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandboxSmall);
  });

  it('should return SandboxSmallContainment for contained ses- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
      { managedScmContainment: true }
    );
    expect(ns).toBe(mockSandboxSmallContainment);
  });

  it('should return SandboxCodeReview for crv- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'crv-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandboxCodeReview);
  });

  it('should return SandboxCodeReviewContainment for contained crv- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'crv-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
      { managedScmContainment: true }
    );
    expect(ns).toBe(mockSandboxCodeReviewContainment);
  });

  it('should return Sandbox for org- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'org-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
  });

  it('should return SandboxContainment for contained org- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'org-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
      { managedScmContainment: true }
    );
    expect(ns).toBe(mockSandboxContainment);
  });

  it('should return Sandbox for usr- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'usr-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
  });

  it('should return Sandbox for bot- prefixed IDs', () => {
    const ns = getSandboxNamespace(mockEnv, 'bot-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
  });

  it('should ignore containment for dind- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'dind-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
      { managedScmContainment: true }
    );
    expect(ns).toBe(mockSandboxDIND);
  });
});

describe('getOutboundContainerId', () => {
  it.each([
    ['org-a1b2c3', 'shared-do-id'],
    ['ses-a1b2c3', 'small-do-id'],
    ['dind-a1b2c3', 'dind-do-id'],
  ])('derives %s from the selected sandbox namespace', (sandboxId, expected) => {
    const createNamespace = (containerId: string) => ({
      idFromName: (name: string) => ({ toString: () => `${containerId}:${name}` }),
    });
    const env = {
      Sandbox: createNamespace('shared-do-id'),
      SandboxSmall: createNamespace('small-do-id'),
      SandboxDIND: createNamespace('dind-do-id'),
    } as unknown as Env;

    expect(getOutboundContainerId(env, sandboxId)).toBe(`${expected}:${sandboxId}`);
  });

  it.each([
    ['org-a1b2c3', 'containment-shared-do-id'],
    ['ses-a1b2c3', 'containment-small-do-id'],
    ['crv-a1b2c3', 'containment-code-review-do-id'],
  ])('derives contained %s from the selected containment namespace', (sandboxId, expected) => {
    const createNamespace = (containerId: string) => ({
      idFromName: (name: string) => ({ toString: () => `${containerId}:${name}` }),
    });
    const env = {
      SandboxContainment: createNamespace('containment-shared-do-id'),
      SandboxSmallContainment: createNamespace('containment-small-do-id'),
      SandboxCodeReviewContainment: createNamespace('containment-code-review-do-id'),
    } as unknown as Env;

    expect(getOutboundContainerId(env, sandboxId, { managedScmContainment: true })).toBe(
      `${expected}:${sandboxId}`
    );
  });
});

describe('isOrgInList', () => {
  it('returns false for an empty list', () => {
    expect(isOrgInList('', 'org-a')).toBe(false);
  });

  it('returns false when the list is undefined', () => {
    expect(isOrgInList(undefined, 'org-a')).toBe(false);
  });

  it('returns true for any org when the list is "*"', () => {
    expect(isOrgInList('*', 'org-a')).toBe(true);
  });

  it('returns true for undefined orgId when the list is "*"', () => {
    expect(isOrgInList('*', undefined)).toBe(true);
  });

  it('returns true when orgId is in the list', () => {
    expect(isOrgInList('org-a,org-b', 'org-b')).toBe(true);
  });

  it('trims whitespace around entries', () => {
    expect(isOrgInList(' org-a , org-b ', 'org-a')).toBe(true);
  });

  it('returns false when orgId is not in the list', () => {
    expect(isOrgInList('org-a,org-b', 'org-c')).toBe(false);
  });

  it('returns false for undefined orgId when the list is specific', () => {
    expect(isOrgInList('org-a,org-b', undefined)).toBe(false);
  });
});
