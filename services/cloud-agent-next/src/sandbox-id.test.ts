import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  deriveSharedSandboxId,
  generateSandboxId,
  generateSandboxRoutingTarget,
  getDefaultSandboxDestination,
  getManagedOutboundContainerId,
  getOutboundContainerId,
  getSandboxNamespace,
  isOrgInList,
  selectSandboxForNewSession,
  selectSandboxProvider,
} from './sandbox-id.js';
import {
  assertSandboxBillingAllocation,
  parseSandboxBillingInput,
} from './container-usage-context.js';
import { isCodeReviewEphemeralSandboxId } from './code-review-ephemeral-sandbox.js';
import { CurrentSessionMetadataSchema } from './persistence/session-metadata.js';
import type { Env, SandboxId } from './types.js';

describe('generateSandboxId', () => {
  const sharedOptions = { sandboxAllocation: 'cloudflare-shared' } as const;

  describe('explicit shared sandbox', () => {
    it('should generate sandboxId within 63 character limit', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        '9d278969-5453-4ae3-a51f-a8d2274a7b56',
        'fd93a81c-63c2-4d14-84b3-60d6ac3b592f',
        'agent_session-1',
        undefined,
        sharedOptions
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
        'c'.repeat(50),
        sharedOptions
      );
      expect(sandboxId.length).toBe(52);
    });

    it('should generate same sandboxId for same inputs', async () => {
      const args = [
        undefined,
        '9d278969-5453-4ae3-a51f-a8d2274a7b56',
        'fd93a81c-63c2-4d14-84b3-60d6ac3b592f',
        'agent_session-1',
        undefined,
        sharedOptions,
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
        sharedOptions,
      ] as const;
      expect(await generateSandboxId(...args)).toBe(await generateSandboxId(...args));
    });

    it('should produce the same shared ID for different sessionIds', async () => {
      const id1 = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        'session-a',
        undefined,
        sharedOptions
      );
      const id2 = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        'session-b',
        undefined,
        sharedOptions
      );
      expect(id1).toBe(id2);
    });

    it('keeps control-plane and legacy shared IDs disjoint for the same owner', async () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const legacy = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        `agent_${uuid}`,
        undefined,
        sharedOptions
      );
      const control = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        `workspace_${uuid}`,
        undefined,
        sharedOptions
      );
      expect(legacy).not.toBe(control);
      expect(legacy.startsWith('org-')).toBe(true);
      expect(control.startsWith('org-')).toBe(true);
    });

    it('keeps control-plane and legacy isolated IDs disjoint', async () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const legacy = await generateSandboxId(undefined, 'org-id', 'user-id', `agent_${uuid}`);
      const control = await generateSandboxId(undefined, 'org-id', 'user-id', `workspace_${uuid}`);
      expect(legacy).not.toBe(control);
      expect(legacy.startsWith('ses-')).toBe(true);
      expect(control.startsWith('ses-')).toBe(true);
    });

    it('derives disjoint shared IDs from control-plane versus legacy route keys', async () => {
      const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const legacyRoute = await generateSandboxRoutingTarget(
        undefined,
        'org-id',
        'user-id',
        `agent_${uuid}`,
        undefined,
        sharedOptions
      );
      const controlRoute = await generateSandboxRoutingTarget(
        undefined,
        'org-id',
        'user-id',
        `workspace_${uuid}`,
        undefined,
        sharedOptions
      );
      expect(legacyRoute.kind).toBe('shared');
      expect(controlRoute.kind).toBe('shared');
      if (legacyRoute.kind !== 'shared' || controlRoute.kind !== 'shared') return;
      expect(legacyRoute.routeKey).not.toBe(controlRoute.routeKey);
      expect(await deriveSharedSandboxId(legacyRoute.routeKey, 'a')).not.toBe(
        await deriveSharedSandboxId(controlRoute.routeKey, 'a')
      );
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
          botId,
          sharedOptions
        );

        expect(target).toEqual({
          kind: 'shared',
          routeKey,
        });
        await expect(deriveSharedSandboxId(routeKey as SandboxId, 'shared-slot-v1')).resolves.toBe(
          failoverSandboxId
        );
        expect(target).toEqual(
          await generateSandboxRoutingTarget(
            undefined,
            orgId,
            'user-id',
            'session-b',
            botId,
            sharedOptions
          )
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
        const id = await generateSandboxId(
          undefined,
          orgId,
          'user-id',
          'session',
          botId,
          sharedOptions
        );

        expect(id).toBe(expectedId);
        expect(id).not.toBe(previousId);
      }
    );
  });

  describe('explicit shared prefix correctness', () => {
    it('should use "org" prefix for organization accounts', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      expect(sandboxId).toMatch(/^org-[0-9a-f]{48}$/);
    });

    it('should use "usr" prefix for personal accounts', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        undefined,
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      expect(sandboxId).toMatch(/^usr-[0-9a-f]{48}$/);
    });

    it('should use "bot" prefix for org accounts with bot', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        'reviewer',
        sharedOptions
      );
      expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
    });

    it('should use "ubt" prefix for personal accounts with bot', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        undefined,
        'user-id',
        's',
        'reviewer',
        sharedOptions
      );
      expect(sandboxId).toMatch(/^ubt-[0-9a-f]{48}$/);
    });
  });

  describe('explicit shared uniqueness', () => {
    it('should generate different IDs for different orgIds', async () => {
      const id1 = await generateSandboxId(
        undefined,
        'org-1',
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      const id2 = await generateSandboxId(
        undefined,
        'org-2',
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different userIds', async () => {
      const id1 = await generateSandboxId(
        undefined,
        'org-id',
        'user-1',
        's',
        undefined,
        sharedOptions
      );
      const id2 = await generateSandboxId(
        undefined,
        'org-id',
        'user-2',
        's',
        undefined,
        sharedOptions
      );
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different botIds', async () => {
      const id1 = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        'bot-1',
        sharedOptions
      );
      const id2 = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        'bot-2',
        sharedOptions
      );
      expect(id1).not.toBe(id2);
    });

    it('should differ between org and personal accounts', async () => {
      const orgId = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      const personal = await generateSandboxId(
        undefined,
        undefined,
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      expect(orgId).not.toBe(personal);
    });

    it('should differ with and without bot', async () => {
      const withoutBot = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        undefined,
        sharedOptions
      );
      const withBot = await generateSandboxId(
        undefined,
        'org-id',
        'user-id',
        's',
        'reviewer',
        sharedOptions
      );
      expect(withoutBot).not.toBe(withBot);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in IDs', async () => {
      const sandboxId = await generateSandboxId(
        undefined,
        'org@123',
        'user#456',
        's',
        'bot$789',
        sharedOptions
      );
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

  describe('per-session sandbox (default)', () => {
    it('bypasses shared slot routing', async () => {
      await expect(
        generateSandboxRoutingTarget(undefined, 'my-org', 'user-id', 'agent_abc123')
      ).resolves.toEqual({
        kind: 'isolated',
        sandboxId: 'ses-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370',
      });
    });

    it('should preserve the existing per-session ID generation', async () => {
      const id = await generateSandboxId(undefined, 'my-org', 'user-id', 'agent_abc123');
      expect(id).toBe('ses-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
    });

    it('should be exactly 52 characters', async () => {
      const id = await generateSandboxId(undefined, 'my-org', 'user-id', 'agent_abc123');
      expect(id.length).toBe(52);
    });

    it('should be deterministic for the same session ID', async () => {
      const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
      const id1 = await generateSandboxId(undefined, 'org', 'user', sessionId);
      const id2 = await generateSandboxId(undefined, 'org', 'user', sessionId);
      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different session IDs', async () => {
      const id1 = await generateSandboxId(undefined, 'org', 'user', 'session-a');
      const id2 = await generateSandboxId(undefined, 'org', 'user', 'session-b');
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

    it('defaults to isolated when perSessionOrgIds is empty', async () => {
      const id = await generateSandboxId('', 'org', 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('defaults to isolated when perSessionOrgIds is undefined', async () => {
      const id = await generateSandboxId(undefined, 'org', 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('defaults to isolated for orgs not in the list', async () => {
      const id = await generateSandboxId('other-org', 'org', 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('defaults personal sessions to isolated without an allowlist', async () => {
      const id = await generateSandboxId(undefined, undefined, 'user', 'session');
      expect(id).toMatch(/^ses-/);
    });

    it('defaults to isolated when orgId is undefined', async () => {
      const id = await generateSandboxId('anything', undefined, 'user', 'session');
      expect(id).toMatch(/^ses-/);
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

  describe('legacy fallback routing', () => {
    it('preserves the shared owner identity for sessions that predate sandboxId storage', async () => {
      const id = await generateSandboxId(undefined, 'org-id', 'user-id', 'session', undefined, {
        legacyFallback: true,
      });
      expect(id).toMatch(/^org-/);
    });

    it('keeps isolated routing for allowlisted orgs', async () => {
      const id = await generateSandboxId('org-id', 'org-id', 'user-id', 'session', undefined, {
        legacyFallback: true,
      });
      expect(id).toMatch(/^ses-/);
    });

    it('preserves the shared identity for personal accounts', async () => {
      const id = await generateSandboxId(undefined, undefined, 'user-id', 'session', undefined, {
        legacyFallback: true,
      });
      expect(id).toMatch(/^usr-/);
    });

    it('still honors an explicit shared allocation', async () => {
      const id = await generateSandboxId(undefined, 'org-id', 'user-id', 'session', undefined, {
        sandboxAllocation: 'cloudflare-shared',
        legacyFallback: true,
      });
      expect(id).toMatch(/^org-/);
    });
  });

  describe('isolated Standard sandbox', () => {
    it('bypasses organization routing with a deterministic per-session identity', async () => {
      await expect(
        generateSandboxRoutingTarget(undefined, 'my-org', 'user-id', 'agent_abc123', undefined, {
          sandboxAllocation: 'isolated-standard',
        })
      ).resolves.toEqual({
        kind: 'isolated',
        sandboxId: 'istd-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370',
      });
    });

    it('produces different identities for different sessions', async () => {
      const first = await generateSandboxId(undefined, 'org', 'user', 'session-a', undefined, {
        sandboxAllocation: 'isolated-standard',
      });
      const second = await generateSandboxId(undefined, 'org', 'user', 'session-b', undefined, {
        sandboxAllocation: 'isolated-standard',
      });

      expect(first).toMatch(/^istd-[0-9a-f]{48}$/);
      expect(second).toMatch(/^istd-[0-9a-f]{48}$/);
      expect(first).not.toBe(second);
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
  });
});

describe('selectSandboxForNewSession', () => {
  const completeVercelConfiguration = {
    VERCEL_SANDBOX_ORG_IDS: 'org-id',
    VERCEL_TOKEN: 'token',
    VERCEL_TEAM_ID: 'team-id',
    VERCEL_PROJECT_ID: 'project-id',
    VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
    VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-id',
    VERCEL_SANDBOX_RUNTIME: 'node24',
    VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
    VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
  };
  const controlSessionId = 'workspace_12345678-1234-1234-1234-123456789abc';
  const legacySessionId = 'agent_12345678-1234-1234-1234-123456789abc';

  it.each(['cloudflare-single', 'cloudflare-shared', 'vercel-small', 'vercel-large'] as const)(
    'routes explicit %s independently of conflicting allocation and provider rollouts',
    async sandboxAllocation => {
      for (const rollout of [undefined, '', '*']) {
        const selection = await selectSandboxForNewSession({
          env: {
            ...completeVercelConfiguration,
            PER_SESSION_SANDBOX_ORG_IDS: rollout,
            VERCEL_SANDBOX_ORG_IDS: rollout,
          },
          orgId: 'org-id',
          userId: 'user-id',
          sessionId: controlSessionId,
          sandboxAllocation,
        });
        expect(selection.provider).toBe(
          sandboxAllocation.startsWith('vercel-') ? 'vercel' : 'cloudflare'
        );
        expect(selection.sandboxId).toMatch(
          sandboxAllocation === 'cloudflare-shared' ? /^org-/ : /^ses-/
        );
      }
    }
  );

  it('retains the shared identity across rollout changes for an explicit shared preset', async () => {
    const shared = await generateSandboxRoutingTarget(
      undefined,
      'org-id',
      'user-id',
      controlSessionId,
      undefined,
      {
        sandboxAllocation: 'cloudflare-shared',
      }
    );
    expect(
      await generateSandboxRoutingTarget('*', 'org-id', 'user-id', controlSessionId, undefined, {
        sandboxAllocation: 'cloudflare-shared',
      })
    ).toEqual(shared);
    expect(
      await generateSandboxRoutingTarget('*', 'org-id', 'other-user', controlSessionId, undefined, {
        sandboxAllocation: 'cloudflare-shared',
      })
    ).not.toEqual(shared);
    expect(
      await generateSandboxRoutingTarget(
        undefined,
        'org-id',
        'user-id',
        legacySessionId,
        undefined,
        {
          sandboxAllocation: 'cloudflare-shared',
        }
      )
    ).not.toEqual(shared);
  });

  it.each(['cloudflare-single', 'cloudflare-shared'] as const)(
    'routes an explicit %s on a legacy session without changing its plane',
    async sandboxAllocation => {
      const selection = await selectSandboxForNewSession({
        env: { ...completeVercelConfiguration, VERCEL_SANDBOX_ORG_IDS: '*' },
        orgId: 'org-id',
        userId: 'user-id',
        sessionId: legacySessionId,
        sandboxAllocation,
      });
      expect(selection.provider).toBe('cloudflare');
      expect(selection.sandboxId).toMatch(
        sandboxAllocation === 'cloudflare-shared' ? /^org-/ : /^ses-/
      );
    }
  );

  it.each(['vercel-small', 'vercel-large'] as const)(
    'rejects %s on a legacy session because Vercel exists only on the control plane',
    async sandboxAllocation => {
      await expect(
        selectSandboxForNewSession({
          env: completeVercelConfiguration,
          orgId: 'org-id',
          userId: 'user-id',
          sessionId: legacySessionId,
          sandboxAllocation,
        })
      ).rejects.toThrow('require a control-plane session');
    }
  );

  it.each([{ orgId: 'org-id' }, {}, { orgId: 'org-id', botId: 'bot-id' }, { botId: 'bot-id' }])(
    'defaults to isolated Cloudflare without an allowlist for %j',
    async owner => {
      const selection = await selectSandboxForNewSession({
        env: {},
        ...owner,
        userId: 'user-id',
        sessionId: 'session-id',
      });

      expect(selection.provider).toBe('cloudflare');
      expect(selection.sandboxId).toMatch(/^ses-/);
    }
  );

  it('selects Vercel for an enabled, allowlisted, isolated control-plane session', async () => {
    const selection = await selectSandboxForNewSession({
      env: completeVercelConfiguration,
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('vercel');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('keeps an enrolled isolated legacy session on Cloudflare', async () => {
    const selection = await selectSandboxForNewSession({
      env: { PER_SESSION_SANDBOX_ORG_IDS: 'org-id', ...completeVercelConfiguration },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: legacySessionId,
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('keeps an enrolled organization on Cloudflare with an explicit shared allocation', async () => {
    const selection = await selectSandboxForNewSession({
      env: { ...completeVercelConfiguration },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: 'session-id',
      sandboxAllocation: 'cloudflare-shared',
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^org-/);
  });

  it.each(Object.keys(completeVercelConfiguration))(
    'keeps partial Vercel configuration on Cloudflare when %s is absent',
    async missingKey => {
      const configuration = { ...completeVercelConfiguration };
      delete configuration[missingKey as keyof typeof configuration];
      const selection = await selectSandboxForNewSession({
        env: { PER_SESSION_SANDBOX_ORG_IDS: 'org-id', ...configuration },
        orgId: 'org-id',
        userId: 'user-id',
        sessionId: 'session-id',
      });

      expect(selection.provider).toBe('cloudflare');
      expect(selection.sandboxId).toMatch(/^ses-/);
    }
  );

  it('keeps organizations outside the explicit Vercel allowlist on Cloudflare', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: 'org-id',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: 'other-org',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: 'session-id',
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects Vercel for any isolated control-plane organization when enrollment is wildcarded', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('vercel');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('keeps personal legacy sessions on Cloudflare even when Vercel enrollment is wildcarded', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
      },
      userId: 'user-id',
      sessionId: legacySessionId,
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects Vercel for personal isolated control-plane sessions when enrollment is wildcarded', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
      },
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('vercel');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('keeps invalid operational configuration on Cloudflare', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: 'org-id',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_RUNTIME: 'node22',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: 'session-id',
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('keeps isolated control-plane sessions on Cloudflare when the containers gate is unset', async () => {
    const selection = await selectSandboxForNewSession({
      env: { PER_SESSION_SANDBOX_ORG_IDS: 'org-id' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects containers for personal isolated control-plane sessions when the gate is wildcarded', async () => {
    const selection = await selectSandboxForNewSession({
      env: { PER_SESSION_SANDBOX_ORG_IDS: '*', CLOUDFLARE_CONTAINERS_ORG_IDS: '*' },
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects containers only for enrolled isolated control-plane organizations', async () => {
    const enrolled = await selectSandboxForNewSession({
      env: { PER_SESSION_SANDBOX_ORG_IDS: 'org-id', CLOUDFLARE_CONTAINERS_ORG_IDS: 'org-id' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });
    const outside = await selectSandboxForNewSession({
      env: { PER_SESSION_SANDBOX_ORG_IDS: 'org-id', CLOUDFLARE_CONTAINERS_ORG_IDS: 'other-org' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(enrolled.provider).toBe('cloudflare-containers');
    expect(outside.provider).toBe('cloudflare');
  });

  it('keeps enrolled isolated legacy sessions on Cloudflare', async () => {
    const selection = await selectSandboxForNewSession({
      env: { PER_SESSION_SANDBOX_ORG_IDS: 'org-id', CLOUDFLARE_CONTAINERS_ORG_IDS: 'org-id' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: legacySessionId,
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('keeps enrolled shared control-plane sessions on Cloudflare', async () => {
    const selection = await selectSandboxForNewSession({
      env: { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
      sandboxAllocation: 'cloudflare-shared',
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^org-/);
  });

  it('keeps Vercel precedence when both enrollments are enabled', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('vercel');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('skips Vercel for an enforced dual-enrolled organization and selects containers', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org-id',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('falls through to Cloudflare for an enforced organization without containers enrollment', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org-id',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('still selects Vercel for a dual-enrolled organization when enforcement is off', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('vercel');
  });

  it('skips Vercel for a personal owner enforced through the user allowlist', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: 'user-id',
      },
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
  });

  it('defaults an enforced owner to containers instead of Vercel', () => {
    const destination = getDefaultSandboxDestination(
      {
        CONTROL_PLANE_IDS: '*',
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        ...completeVercelConfiguration,
        VERCEL_SANDBOX_ORG_IDS: '*',
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org-id',
      },
      { userId: 'user-id', orgId: 'org-id' }
    );

    expect(destination.provider.id).toBe('cloudflare-containers');
    expect(destination.instanceType).toBe('standard-4');
  });
});

describe('non-contained sandbox consolidation', () => {
  const namespaces = {
    Sandbox: {},
    SandboxContainment: {},
    SandboxSmall: {},
    SandboxSmallContainment: {},
    SandboxCodeReview: {},
    SandboxCodeReviewContainment: {},
    SandboxDIND: {},
  } as unknown as Env;

  it.each([
    [undefined, undefined, 'ses-', 'SandboxSmallContainment'],
    ['cloudflare-single', undefined, 'ses-', 'SandboxSmallContainment'],
    ['isolated-standard', undefined, 'istd-', 'SandboxContainment'],
    [undefined, 'code-review', 'crv-', 'SandboxCodeReviewContainment'],
  ] as const)(
    'routes non-contained %s / %s sandboxes to Sandbox and keeps their containment pool',
    async (sandboxAllocation, createdOnPlatform, prefix, containedNamespace) => {
      const sessionId = 'agent_abc123';
      const sandboxId = await generateSandboxId('*', 'org-id', 'user-id', sessionId, undefined, {
        sandboxAllocation,
        createdOnPlatform,
      });
      expect(sandboxId.startsWith(prefix)).toBe(true);
      expect(getSandboxNamespace(namespaces, sandboxId)).toBe(namespaces.Sandbox);
      expect(getSandboxNamespace(namespaces, sandboxId, { managedScmContainment: true })).toBe(
        namespaces[containedNamespace]
      );
      const provider = selectSandboxProvider({
        env: {},
        orgId: 'org-id',
        userId: 'user-id',
        sessionId,
        sandboxId,
        sandboxAllocation,
      });
      expect(provider).toBe('cloudflare');
      expect(
        CurrentSessionMetadataSchema.safeParse({
          metadataSchemaVersion: 2,
          identity: { sessionId, userId: 'user-id' },
          auth: {},
          lifecycle: { version: 1, timestamp: 1 },
          workspace: { sandboxId, sandboxProvider: provider, sandboxAllocation },
        }).success
      ).toBe(true);
      const billing = parseSandboxBillingInput({
        sandboxId,
        subject: { type: 'user', id: 'user-id' },
        actor: { type: 'user', id: 'user-id' },
        sessionId,
        metadata: { origin: createdOnPlatform ?? 'cloud-agent' },
        enforcementRequested: true,
      });
      expect(() => assertSandboxBillingAllocation('Sandbox', billing)).not.toThrow();
      expect(() => assertSandboxBillingAllocation(containedNamespace, billing)).not.toThrow();
      expect(isCodeReviewEphemeralSandboxId(sandboxId)).toBe(createdOnPlatform === 'code-review');
    }
  );

  it.each(['ses-abcdef', 'crv-abcdef'] as const)(
    'keeps the contained standard pool strict for %s',
    sandboxId => {
      const billing = parseSandboxBillingInput({
        sandboxId,
        subject: { type: 'user', id: 'user-id' },
        actor: { type: 'user', id: 'user-id' },
        sessionId: 'agent_abc123',
        metadata: { origin: 'cloud-agent' },
      });
      expect(() => assertSandboxBillingAllocation('SandboxContainment', billing)).toThrow(
        'incompatible sandbox ID'
      );
    }
  );
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

  it('routes non-contained ses- prefixed IDs to Sandbox, not the retired Small pool', () => {
    const ns = getSandboxNamespace(mockEnv, 'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
    expect(ns).not.toBe(mockSandboxSmall);
  });

  it('should return SandboxSmallContainment for contained ses- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'ses-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
      { managedScmContainment: true }
    );
    expect(ns).toBe(mockSandboxSmallContainment);
  });

  it('should return Sandbox for istd- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'istd-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'
    );
    expect(ns).toBe(mockSandbox);
  });

  it('should return SandboxContainment for contained istd- prefixed IDs', () => {
    const ns = getSandboxNamespace(
      mockEnv,
      'istd-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
      { managedScmContainment: true }
    );
    expect(ns).toBe(mockSandboxContainment);
  });

  it('routes non-contained crv- prefixed IDs to Sandbox, not the retired review pool', () => {
    const ns = getSandboxNamespace(mockEnv, 'crv-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6');
    expect(ns).toBe(mockSandbox);
    expect(ns).not.toBe(mockSandboxCodeReview);
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
    ['ses-a1b2c3', 'shared-do-id'],
    ['crv-a1b2c3', 'shared-do-id'],
    ['istd-a1b2c3', 'shared-do-id'],
    ['dind-a1b2c3', 'dind-do-id'],
  ])('derives %s from the selected sandbox namespace', (sandboxId, expected) => {
    const createNamespace = (containerId: string) => ({
      idFromName: (name: string) => ({ toString: () => `${containerId}:${name}` }),
    });
    const env = {
      Sandbox: createNamespace('shared-do-id'),
      SandboxSmall: createNamespace('small-do-id'),
      SandboxCodeReview: createNamespace('review-do-id'),
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

describe('getManagedOutboundContainerId', () => {
  it('binds containers containment to the containers Durable Object, not the sandbox class', () => {
    const env = {
      SANDBOX_CONTAINERS: {
        idFromName: (name: string) => ({ toString: () => `containers:${name}` }),
      },
      SandboxSmallContainment: {
        idFromName: (name: string) => ({ toString: () => `sandbox:${name}` }),
      },
    } as unknown as Env;

    expect(
      getManagedOutboundContainerId('cloudflare-containers', env, {
        logicalSandboxId: 'ses-logical',
        physicalSandboxId: 'ses-physical',
      })
    ).toBe('containers:ses-logical');
    expect(
      getManagedOutboundContainerId('cloudflare', env, {
        logicalSandboxId: 'ses-logical',
        physicalSandboxId: 'ses-physical',
      })
    ).toBe('sandbox:ses-physical');
    expect(
      getManagedOutboundContainerId('vercel', env, {
        logicalSandboxId: 'ses-logical',
        physicalSandboxId: 'ses-physical',
      })
    ).toBeUndefined();
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
