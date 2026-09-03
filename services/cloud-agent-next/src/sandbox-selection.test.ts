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
  SANDBOX_SELECTION_ORG_IDS: 'org-id',
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
      name: 'unchanged default when explicit Vercel is unavailable for compute billing',
      overrides: {
        PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_SANDBOX_ORG_IDS: owner.orgId,
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
      },
      devcontainer: false,
      expected: { provider: { id: 'vercel', account: 'kilo' }, instanceType: 'default' },
    },
  ])(
    'previews $name consistently with actual routing',
    async ({ overrides, devcontainer, expected }) => {
      const env = { ...configured, ...overrides } as Env;
      const capabilities = getSandboxSelectionCapabilities(env, owner, devcontainer);
      expect(capabilities.defaultDestination).toEqual(expected);
      const plane = sessionPlaneForNewOwner(env, owner);
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
              available: true,
            },
          ],
        },
        'vercel-small'
      )
    ).toBe(false);
  });

  it.each([
    { SANDBOX_SELECTION_ORG_IDS: undefined },
    { SANDBOX_SELECTION_ORG_IDS: '' },
    { SANDBOX_SELECTION_ORG_IDS: 'other-org' },
    { SANDBOX_SELECTION_ORG_IDS: '', NODE_ENV: 'development' },
  ])('disables selection without the organization allowlist: %j', overrides => {
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

  it('never enables personal selection, including wildcard rollouts', () => {
    const env = { ...configured, SANDBOX_SELECTION_ORG_IDS: '*', CONTROL_PLANE_IDS: '*' } as Env;
    expect(getSandboxSelectionCapabilities(env, { userId: owner.userId })).toEqual({
      enabled: false,
      options: [],
    });
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
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities.enabled).toBe(true);
    expect(capabilities.options).toHaveLength(4);
    expect(capabilities.options.every(option => option.available)).toBe(true);
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
      expect(
        capabilities.options.filter(option => option.available).map(option => option.allocation)
      ).toEqual([
        getSandboxAllocationRequest('cloudflare-single'),
        getSandboxAllocationRequest('cloudflare-shared'),
      ]);
      for (const preset of ['vercel-small', 'vercel-large'] as const) {
        expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
          'not configured'
        );
      }
    }
  );

  it('fails Vercel closed for enforced organization billing', () => {
    const env = {
      ...configured,
      CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
      CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
    } as Env;
    for (const preset of ['vercel-small', 'vercel-large'] as const) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
        'enforced compute billing'
      );
    }
    expect(() => assertSandboxAllocationAvailable(env, owner, 'cloudflare-single')).not.toThrow();
  });
});
