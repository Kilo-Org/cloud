import { describe, expect, it } from 'vitest';
import {
  getSandboxAllocationRequest,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  assertSandboxAllocationAvailable,
  getSandboxSelectionCapabilities,
  isSandboxAllocationAvailable,
} from './sandbox-selection.js';
import { classifySandboxId, selectSandboxForNewSession } from './sandbox-id.js';
import { sessionPlaneForNewOwner } from './session-plane.js';
import type { Env } from './types.js';

const configured = {
  SANDBOX_SELECTION_IDS: 'org-id',
  CONTROL_PLANE_IDS: 'org-id',
  VERCEL_TOKEN: 'test-token',
  VERCEL_TEAM_ID: 'team-id',
  VERCEL_PROJECT_ID: 'project-id',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-id',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
} satisfies Partial<Env>;
const owner = { userId: 'oauth/user', orgId: 'org-id' };

describe('sandbox selection policy', () => {
  it.each([
    {
      name: 'shared Cloudflare',
      overrides: {},
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-shared'),
    },
    {
      name: 'isolated Cloudflare',
      overrides: { PER_SESSION_SANDBOX_ORG_IDS: owner.orgId },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-single'),
    },
    {
      name: 'Vercel with provider-default resources',
      overrides: { PER_SESSION_SANDBOX_ORG_IDS: owner.orgId, VERCEL_SANDBOX_ORG_IDS: owner.orgId },
      devcontainer: false,
      expected: { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
    },
    {
      name: 'Vercel with user-level control-plane enrollment',
      overrides: {
        CONTROL_PLANE_IDS: owner.userId,
        PER_SESSION_SANDBOX_ORG_IDS: '*',
        VERCEL_SANDBOX_ORG_IDS: '*',
      },
      devcontainer: false,
      expected: { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
    },
    {
      name: 'legacy isolation despite Vercel enrollment',
      overrides: {
        CONTROL_PLANE_IDS: '',
        PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_SANDBOX_ORG_IDS: owner.orgId,
      },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-single'),
    },
    {
      name: 'shared routing despite Vercel enrollment',
      overrides: { VERCEL_SANDBOX_ORG_IDS: owner.orgId },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-shared'),
    },
    {
      name: 'missing Vercel configuration',
      overrides: {
        PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_TOKEN: undefined,
      },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-single'),
    },
    {
      name: 'devcontainer instead of the normal Vercel default',
      overrides: { PER_SESSION_SANDBOX_ORG_IDS: owner.orgId, VERCEL_SANDBOX_ORG_IDS: owner.orgId },
      devcontainer: true,
      expected: { provider: { id: 'cloudflare', account: 'kilo' }, instanceType: 'devcontainer' },
    },
    {
      name: 'enforced default skips Vercel even when explicit Vercel is enrolled',
      overrides: {
        PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_SANDBOX_ORG_IDS: owner.orgId,
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
      },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-single'),
    },
    {
      name: 'Cloudflare containers when the isolated owner is enrolled',
      overrides: {
        PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_SANDBOX_ORG_IDS: '',
        CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
      },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-4'),
    },
    {
      name: 'unchanged shared Cloudflare when the owner is not isolated',
      overrides: {
        VERCEL_SANDBOX_ORG_IDS: '',
        CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
      },
      devcontainer: false,
      expected: getSandboxAllocationRequest('cloudflare-shared'),
    },
  ])(
    'previews $name consistently with actual routing',
    async ({ overrides, devcontainer, expected }) => {
      const env = { ...configured, ...overrides } as Env;
      const capabilities = getSandboxSelectionCapabilities(env, owner, devcontainer);
      expect(capabilities.defaultDestination).toEqual(expected);
      const plane = sessionPlaneForNewOwner(env, owner, { createdOnPlatform: 'cloud-agent-web' });
      const actual = await selectSandboxForNewSession({
        env,
        ...owner,
        sessionId: `${plane === 'control' ? 'workspace' : 'agent'}_12345678-1234-1234-1234-123456789012`,
        devcontainer,
      });
      expect(actual.provider).toBe(expected.provider.id);
      if (actual.provider === 'cloudflare') {
        expect(classifySandboxId(actual.sandboxId)).toBe(
          expected.instanceType === 'shared'
            ? 'shared'
            : expected.instanceType === 'devcontainer'
              ? 'devcontainer'
              : 'isolated-small'
        );
      }
    }
  );

  it('does not authorize a Kilo allocation from a BYOC capability with the same size', () => {
    expect(
      isSandboxAllocationAvailable(
        {
          enabled: true,
          options: [
            {
              allocation: { provider: { id: 'vercel', account: 'byoc' }, instanceType: 'small' },
            },
          ],
        },
        'vercel-small'
      )
    ).toBe(false);
  });

  it.each([
    { SANDBOX_SELECTION_IDS: undefined },
    { SANDBOX_SELECTION_IDS: '' },
    { SANDBOX_SELECTION_IDS: 'other-org' },
    { SANDBOX_SELECTION_IDS: '', NODE_ENV: 'development' },
  ])('disables selection without the owner allowlist: %j', overrides => {
    const env = { ...configured, ...overrides } as Env;
    expect(getSandboxSelectionCapabilities(env, owner)).toEqual({ enabled: false, options: [] });
    for (const preset of sandboxAllocationSchema.options) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow('not enabled');
    }
  });

  it('keeps the trigger-only allocation out of the manual picker', () => {
    const capabilities = getSandboxSelectionCapabilities(configured as Env, owner);
    expect(capabilities.options.map(option => option.allocation)).toEqual([
      getSandboxAllocationRequest('cloudflare-single'),
      getSandboxAllocationRequest('cloudflare-shared'),
      getSandboxAllocationRequest('vercel-small'),
      getSandboxAllocationRequest('vercel-large'),
    ]);
  });

  it('enables personal selection when the user is listed', () => {
    const env = { ...configured, SANDBOX_SELECTION_IDS: owner.userId } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, { userId: owner.userId });
    expect(capabilities.enabled).toBe(true);
    expect(capabilities.options).toHaveLength(4);
  });

  it('enables personal selection for wildcard rollouts', () => {
    const env = { ...configured, SANDBOX_SELECTION_IDS: '*', CONTROL_PLANE_IDS: '*' } as Env;
    expect(getSandboxSelectionCapabilities(env, { userId: owner.userId }).enabled).toBe(true);
  });

  it('does not enable personal selection from an organization-only allowlist', () => {
    expect(getSandboxSelectionCapabilities(configured as Env, { userId: owner.userId })).toEqual({
      enabled: false,
      options: [],
    });
  });

  it('enables an organization session when the user is listed', () => {
    const env = { ...configured, SANDBOX_SELECTION_IDS: owner.userId } as Env;
    expect(getSandboxSelectionCapabilities(env, owner).enabled).toBe(true);
  });

  it.each([
    { CONTROL_PLANE_IDS: 'org-id' },
    { CONTROL_PLANE_IDS: owner.userId },
    // Plane enrollment is not an availability condition: a legacy owner may still
    // choose, and a Vercel choice plane-forces that one session.
    { CONTROL_PLANE_IDS: '' },
    { CONTROL_PLANE_IDS: undefined },
    { CONTROL_PLANE_IDS: 'other-owner' },
  ])('enables selection regardless of plane enrollment: %j', overrides => {
    const env = {
      ...configured,
      ...overrides,
      VERCEL_SANDBOX_ORG_IDS: '',
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities.enabled).toBe(true);
    expect(capabilities.options).toHaveLength(6);
    expect(capabilities.options.every(option => !('available' in option))).toBe(true);
    expect(JSON.stringify(capabilities)).not.toContain('test-token');
    for (const preset of sandboxAllocationSchema.options) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).not.toThrow();
    }
  });

  it.each(Object.keys(configured).filter(key => key.startsWith('VERCEL_')))(
    'disables only Vercel when operational configuration %s is absent',
    key => {
      const env = { ...configured, [key]: undefined } as Env;
      const capabilities = getSandboxSelectionCapabilities(env, owner);
      expect(capabilities.enabled).toBe(true);
      expect(capabilities.options.map(option => option.allocation)).toEqual([
        getSandboxAllocationRequest('cloudflare-single'),
        getSandboxAllocationRequest('cloudflare-shared'),
      ]);
      for (const preset of ['vercel-small', 'vercel-large'] as const) {
        expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
          'not configured'
        );
      }
      expect(() => assertSandboxAllocationAvailable(env, owner, 'isolated-standard')).not.toThrow();
    }
  );

  it('advertises only Vercel allocations to BYOC-enrolled organizations', () => {
    const env = { ...configured, BYOC_VERCEL_ORG_IDS: owner.orgId } as Env;
    expect(
      getSandboxSelectionCapabilities(env, owner).options.map(option => option.allocation)
    ).toEqual([
      getSandboxAllocationRequest('vercel-small'),
      getSandboxAllocationRequest('vercel-large'),
    ]);
    for (const preset of ['cloudflare-single', 'cloudflare-shared'] as const) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
        'cannot select non-Vercel allocations'
      );
    }
    expect(() => assertSandboxAllocationAvailable(env, owner, 'vercel-small')).not.toThrow();
  });

  it('keeps Cloudflare allocations for personal sessions under a BYOC wildcard', () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: '*',
      BYOC_VERCEL_ORG_IDS: '*',
    } as Env;
    expect(
      getSandboxSelectionCapabilities(env, { userId: owner.userId }).options.map(
        option => option.allocation
      )
    ).toContainEqual(getSandboxAllocationRequest('cloudflare-single'));
  });

  it('fails Vercel closed for enforced organization billing', () => {
    const env = {
      ...configured,
      CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
      CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities.options.map(option => option.allocation)).toEqual([
      getSandboxAllocationRequest('cloudflare-single'),
      getSandboxAllocationRequest('cloudflare-shared'),
    ]);
    for (const preset of ['vercel-small', 'vercel-large'] as const) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
        'enforced compute billing'
      );
    }
    expect(() => assertSandboxAllocationAvailable(env, owner, 'cloudflare-single')).not.toThrow();
  });

  it('offers every Cloudflare containers size only to enrolled owners', () => {
    const enrolled = {
      ...configured,
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    const options = getSandboxSelectionCapabilities(enrolled, owner).options.map(
      option => option.allocation
    );
    expect(options).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-3'));
    expect(options).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-4'));
    for (const allocation of [
      'cloudflare-containers-standard-3',
      'cloudflare-containers-standard-4',
    ] as const) {
      expect(() => assertSandboxAllocationAvailable(enrolled, owner, allocation)).not.toThrow();
    }

    const unenrolled = { ...configured, CLOUDFLARE_CONTAINERS_ORG_IDS: 'other-org' } as Env;
    expect(
      getSandboxSelectionCapabilities(unenrolled, owner).options.map(option => option.allocation)
    ).not.toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-3'));
    expect(() =>
      assertSandboxAllocationAvailable(unenrolled, owner, 'cloudflare-containers-standard-3')
    ).toThrow('not enabled for this account');
  });

  it('admits personal Cloudflare containers enrollment only for the wildcard', () => {
    const wildcard = {
      ...configured,
      SANDBOX_SELECTION_IDS: '*',
      CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
    } as Env;
    expect(
      getSandboxSelectionCapabilities(wildcard, { userId: owner.userId }).options.map(
        option => option.allocation
      )
    ).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-4'));

    const orgOnly = {
      ...configured,
      SANDBOX_SELECTION_IDS: '*',
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    expect(
      getSandboxSelectionCapabilities(orgOnly, { userId: owner.userId }).options.map(
        option => option.allocation
      )
    ).not.toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-4'));
  });

  it('offers Cloudflare containers to an enrolled owner under enforced organization billing', () => {
    const env = {
      ...configured,
      PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
      CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
      CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    const options = capabilities.options.map(option => option.allocation);
    expect(options).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-3'));
    expect(options).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-4'));
    expect(capabilities.defaultDestination).toEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-4')
    );
    expect(options).toContainEqual(capabilities.defaultDestination);
    expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-containers-standard-4')).toBe(
      true
    );
  });

  it('admits the trigger-only allocation without listing it', () => {
    expect(isSandboxAllocationAvailable({ enabled: true, options: [] }, 'isolated-standard')).toBe(
      true
    );
    expect(
      isSandboxAllocationAvailable(
        {
          enabled: true,
          options: [{ allocation: getSandboxAllocationRequest('cloudflare-single') }],
        },
        'isolated-standard'
      )
    ).toBe(true);
    expect(isSandboxAllocationAvailable({ enabled: false, options: [] }, 'isolated-standard')).toBe(
      false
    );
  });
});
