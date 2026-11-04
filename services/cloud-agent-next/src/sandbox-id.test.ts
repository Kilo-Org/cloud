import { describe, expect, it } from 'vitest';
import { getSandboxAllocationRequest } from '@kilocode/worker-utils/sandbox-allocation';
import {
  generateSandboxId,
  getDefaultSandboxDestination,
  getManagedOutboundContainerId,
  isOrgInList,
  selectSandboxForNewSession,
  selectSandboxProvider,
} from './sandbox-id.js';
import {
  assertSandboxBillingAllocation,
  parseSandboxBillingInput,
} from './container-usage-context.js';
import { CurrentSessionMetadataSchema } from './persistence/session-metadata.js';
import type { Env } from './types.js';

describe('generateSandboxId', () => {
  it('generates a deterministic isolated identity within the 63 character limit', async () => {
    const id = await generateSandboxId('agent_abc123');
    expect(id).toBe('ses-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
    expect(id.length).toBe(52);
    expect(await generateSandboxId('agent_abc123')).toBe(id);
  });

  it('produces different identities for different sessions', async () => {
    expect(await generateSandboxId('session-a')).not.toBe(await generateSandboxId('session-b'));
  });

  it('keeps the isolated Standard prefix for an explicit allocation', async () => {
    await expect(
      generateSandboxId('agent_abc123', { sandboxAllocation: 'isolated-standard' })
    ).resolves.toBe('istd-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
  });

  it('routes Code Reviewer sessions to dedicated crv sandboxes', async () => {
    await expect(
      generateSandboxId('agent_abc123', { createdOnPlatform: 'code-review' })
    ).resolves.toBe('crv-51256c9fcd04ef0144d0afcdfb9ffb2abc280ff2e0bae370');
  });

  it('never generates a shared sandbox identity', async () => {
    await expect(
      generateSandboxId('agent_abc123', { sandboxAllocation: 'cloudflare-shared' })
    ).rejects.toThrow('Shared sandboxes are retired');
  });
});

describe('selectSandboxForNewSession', () => {
  const completeVercelConfiguration = {
    CREDENTIAL_CONTAINMENT_ENABLED: undefined,
    ...{ VERCEL_SANDBOX_ORG_IDS: 'org-id' },
    ...{ VERCEL_TOKEN: 'token' },
    ...{ VERCEL_TEAM_ID: 'team-id' },
    ...{ VERCEL_PROJECT_ID: 'project-id' },
    ...{ VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id' },
    ...{ VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-id' },
    ...{ VERCEL_SANDBOX_RUNTIME: 'node24' },
    ...{ VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000' },
    ...{ VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000' },
  };
  const controlSessionId = 'workspace_12345678-1234-1234-1234-123456789abc';

  it.each(['cloudflare-single', 'vercel-small', 'vercel-large'] as const)(
    'routes explicit %s independently of conflicting allocation and provider rollouts',
    async sandboxAllocation => {
      for (const rollout of [undefined, '', '*']) {
        const selection = await selectSandboxForNewSession({
          env: {
            ...completeVercelConfiguration,
            ...{ VERCEL_SANDBOX_ORG_IDS: rollout },
          },
          orgId: 'org-id',
          userId: 'user-id',
          sessionId: controlSessionId,
          sandboxAllocation,
        });
        expect(selection.provider).toBe(
          sandboxAllocation === 'cloudflare-single' ? 'cloudflare-containers' : 'vercel'
        );
        expect(selection.sandboxId).toMatch(/^ses-/);
      }
    }
  );

  it.each([{ orgId: 'org-id' }, {}])(
    'defaults to isolated native containers without an allowlist for %j',
    async owner => {
      const selection = await selectSandboxForNewSession({
        env: {},
        ...owner,
        userId: 'user-id',
        sessionId: 'session-id',
      });

      expect(selection.provider).toBe('cloudflare-containers');
      expect(selection.sandboxId).toMatch(/^ses-/);
    }
  );

  it('ignores retired Vercel platform enrollment for an isolated control-plane session', async () => {
    const selection = await selectSandboxForNewSession({
      env: completeVercelConfiguration,
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('rejects an explicit shared allocation', async () => {
    await expect(
      selectSandboxForNewSession({
        env: { ...completeVercelConfiguration, CLOUDFLARE_CONTAINERS_ORG_IDS: '*' },
        orgId: 'org-id',
        userId: 'user-id',
        sessionId: 'session-id',
        sandboxAllocation: 'cloudflare-shared',
      })
    ).rejects.toThrow('Shared sandboxes are retired');
  });

  it.each(Object.keys(completeVercelConfiguration))(
    'uses native containers for partial Vercel configuration when %s is absent',
    async missingKey => {
      const configuration = { ...completeVercelConfiguration };
      delete configuration[missingKey as keyof typeof configuration];
      const selection = await selectSandboxForNewSession({
        env: configuration,
        orgId: 'org-id',
        userId: 'user-id',
        sessionId: 'session-id',
      });

      expect(selection.provider).toBe('cloudflare-containers');
      expect(selection.sandboxId).toMatch(/^ses-/);
    }
  );

  it('uses native containers outside the explicit Vercel allowlist', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: 'other-org' },
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: 'session-id',
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('ignores the retired wildcard for isolated organizations', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects Vercel for personal isolated control-plane sessions when enrollment is wildcarded', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
      },
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('uses native containers for invalid Vercel configuration', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_RUNTIME: 'node22' },
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: 'session-id',
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('moves isolated control-plane sessions to native containers when the containers gate is unset', async () => {
    const selection = await selectSandboxForNewSession({
      env: {},
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects containers for personal isolated control-plane sessions when the gate is wildcarded', async () => {
    const selection = await selectSandboxForNewSession({
      env: { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' },
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('selects containers for enrolled and unenrolled isolated control-plane organizations', async () => {
    const enrolled = await selectSandboxForNewSession({
      env: { CLOUDFLARE_CONTAINERS_ORG_IDS: 'org-id' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });
    const outside = await selectSandboxForNewSession({
      env: { CLOUDFLARE_CONTAINERS_ORG_IDS: 'other-org' },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(enrolled.provider).toBe('cloudflare-containers');
    expect(outside.provider).toBe('cloudflare-containers');
  });

  it('uses Cloudflare containers when retired Vercel enrollment is also present', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
    expect(selection.sandboxId).toMatch(/^ses-/);
  });

  it('skips Vercel for an enforced dual-enrolled organization and selects containers', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
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

  it('moves an enforced organization without containers enrollment to native containers', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
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

  it('uses Cloudflare containers when enforcement is off', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'false',
      },
      orgId: 'org-id',
      userId: 'user-id',
      sessionId: controlSessionId,
    });

    expect(selection.provider).toBe('cloudflare-containers');
  });

  it('skips Vercel for a personal owner enforced through the user allowlist', async () => {
    const selection = await selectSandboxForNewSession({
      env: {
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
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
        ...completeVercelConfiguration,
        ...{ VERCEL_SANDBOX_ORG_IDS: '*' },
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org-id',
      },
      { userId: 'user-id', orgId: 'org-id' }
    );

    expect(destination.provider.id).toBe('cloudflare-containers');
    expect(destination.instanceType).toBe('standard-3');
  });

  it('keeps BYOC enrollment from overriding the Cloudflare default', async () => {
    const env = {
      ...completeVercelConfiguration,
      BYOC_VERCEL_IDS: '*',
      VERCEL_SANDBOX_ORG_IDS: '*',
    };
    const destination = getDefaultSandboxDestination(env, { userId: 'user-id' });
    expect(destination).toEqual(getSandboxAllocationRequest('cloudflare-containers-standard-3'));

    const selection = await selectSandboxForNewSession({
      env,
      userId: 'user-id',
      sessionId: controlSessionId,
    });
    expect(selection.provider).toBe('cloudflare-containers');
  });
});

describe('legacy sandbox retirement', () => {
  it.each([
    [undefined, undefined, 'ses-', 'cloudflare-containers'],
    ['cloudflare-single', undefined, 'ses-', 'cloudflare'],
    ['isolated-standard', undefined, 'istd-', 'cloudflare'],
    [undefined, 'code-review', 'crv-', 'cloudflare'],
  ] as const)(
    'generates the historical %s / %s sandbox identity',
    async (sandboxAllocation, createdOnPlatform, prefix, expectedProvider) => {
      const sessionId = 'workspace_abc123';
      const sandboxId = await generateSandboxId(sessionId, {
        sandboxAllocation,
        createdOnPlatform,
      });
      expect(sandboxId.startsWith(prefix)).toBe(true);
      const provider = selectSandboxProvider({
        env: {},
        orgId: 'org-id',
        userId: 'user-id',
        sessionId,
        sandboxId,
        sandboxAllocation,
      });
      expect(provider).toBe(expectedProvider);
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
      const billingClass = sandboxId.startsWith('crv-')
        ? 'SandboxContainersCodeReview'
        : sandboxId.startsWith('istd-')
          ? 'SandboxContainment'
          : 'SandboxSmallContainment';
      expect(() => assertSandboxBillingAllocation(billingClass, billing)).not.toThrow();
      expect(sandboxId.startsWith('crv-')).toBe(createdOnPlatform === 'code-review');
    }
  );
});

describe('getManagedOutboundContainerId', () => {
  const env = {
    SANDBOX_CONTAINERS: {
      idFromName: (name: string) => ({ toString: () => `containers:${name}` }),
    },
  } as unknown as Env;
  const ids = { logicalSandboxId: 'sbx-logical', physicalSandboxId: 'ses-physical' };

  it('names the native containers Durable Object by the logical sandbox id', () => {
    expect(getManagedOutboundContainerId('cloudflare-containers', env, ids)).toBe(
      'containers:sbx-logical'
    );
  });

  it('fails closed for the retired Cloudflare Sandbox provider', () => {
    expect(() => getManagedOutboundContainerId('cloudflare', env, ids)).toThrow(
      'runtime has been retired'
    );
  });

  it('has no outbound proxy for Vercel', () => {
    expect(getManagedOutboundContainerId('vercel', env, ids)).toBeUndefined();
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
