import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSandboxAllocation,
  getSandboxAllocationRequest,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  assertSandboxAllocationAvailable,
  getSandboxSelectionCapabilities,
  isSandboxAllocationAvailable,
  resolveVercelSelectionReadiness,
} from './sandbox-selection.js';
import { classifySandboxId, selectSandboxForNewSession } from './sandbox-id.js';
import { appRouter } from './router.js';
import { ByocCredentialMissingError } from './byoc/vercel-credential-resolver.js';
import type * as ByocCredentialResolverModule from './byoc/vercel-credential-resolver.js';
import type { Env, TRPCContext } from './types.js';

const { fetchByocVercelEnrollmentMock, fetchByocVercelEnrollmentForUserMock } = vi.hoisted(() => ({
  fetchByocVercelEnrollmentMock: vi.fn(),
  fetchByocVercelEnrollmentForUserMock: vi.fn(),
}));
vi.mock('./byoc/vercel-credential-resolver.js', async importActual => {
  const actual = await importActual<typeof ByocCredentialResolverModule>();
  return {
    ...actual,
    fetchByocVercelEnrollment: fetchByocVercelEnrollmentMock,
    fetchByocVercelEnrollmentForUser: fetchByocVercelEnrollmentForUserMock,
  };
});

const configured = Object.assign({} as Env, {
  SANDBOX_SELECTION_IDS: 'org-id',
  VERCEL_TOKEN: 'test-token',
  VERCEL_TEAM_ID: 'team-id',
  VERCEL_PROJECT_ID: 'project-id',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-id',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
});
const owner = { userId: 'oauth/user', orgId: 'org-id' };

type Capabilities = ReturnType<typeof getSandboxSelectionCapabilities>;

const availableOptions = (capabilities: Capabilities) =>
  capabilities.options
    .filter(
      option =>
        option.unavailableReason === undefined && option.repositoryUnavailableReason === undefined
    )
    .map(option => option.allocation);

beforeEach(() => {
  fetchByocVercelEnrollmentMock.mockReset();
  fetchByocVercelEnrollmentForUserMock.mockReset();
  fetchByocVercelEnrollmentMock.mockResolvedValue({
    organizationId: owner.orgId,
    credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4aa',
    setupStatus: 'ready',
  });
  fetchByocVercelEnrollmentForUserMock.mockResolvedValue({
    userId: owner.userId,
    credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4ab',
    setupStatus: 'ready',
  });
});

describe('sandbox selection policy', () => {
  it.each([
    {
      name: 'isolated Cloudflare without an allowlist',
      overrides: {},
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'isolated Cloudflare with an empty allowlist',
      overrides: { PER_SESSION_SANDBOX_ORG_IDS: '' },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'Vercel with provider-default resources',
      overrides: { VERCEL_SANDBOX_ORG_IDS: owner.orgId },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'Vercel with personal Vercel enrollment',
      overrides: {
        VERCEL_SANDBOX_ORG_IDS: '*',
      },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'isolated Cloudflare outside the former allowlist',
      overrides: { PER_SESSION_SANDBOX_ORG_IDS: 'other-org' },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'missing Vercel configuration',
      overrides: {
        VERCEL_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_TOKEN: undefined,
      },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'keeps Cloudflare sandbox small when containment is disabled',
      overrides: { CREDENTIAL_CONTAINMENT_ENABLED: 'false' },
      expected: getSandboxAllocationRequest('cloudflare-single'),
    },
    {
      name: 'enforced default skips Vercel even when explicit Vercel is enrolled',
      overrides: {
        VERCEL_SANDBOX_ORG_IDS: owner.orgId,
        CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
        CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
      },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'Cloudflare containers when the isolated owner is enrolled',
      overrides: {
        PER_SESSION_SANDBOX_ORG_IDS: owner.orgId,
        VERCEL_SANDBOX_ORG_IDS: '',
        CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
      },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
    {
      name: 'Cloudflare containers without an isolation allowlist',
      overrides: {
        VERCEL_SANDBOX_ORG_IDS: '',
        CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
      },
      expected: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    },
  ])('previews $name consistently with actual routing', async ({ overrides, expected }) => {
    const env = { ...configured, ...overrides } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities.defaultDestination).toEqual(expected);
    const actual = await selectSandboxForNewSession({
      env,
      ...owner,
      sessionId: 'workspace_12345678-1234-1234-1234-123456789012',
    });
    expect(actual.provider).toBe(expected.provider.id);
    if (actual.provider === 'cloudflare') {
      expect(classifySandboxId(actual.sandboxId)).toBe('isolated-small');
    }
  });

  it('authorizes a BYOC allocation from the matching BYOC capability', () => {
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
    ).toBe(true);
  });

  it.each([{ userId: owner.userId }, owner])(
    'defaults enrolled owners to native medium without selection permission: %j',
    async owner => {
      const env = {
        ...configured,
        SANDBOX_SELECTION_IDS: '',
        CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
      } as Env;

      expect(getSandboxSelectionCapabilities(env, owner)).toEqual({
        enabled: false,
        options: [],
        defaultDestination: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      });
      const actual = await selectSandboxForNewSession({
        env,
        ...owner,
        sessionId: 'workspace_12345678-1234-1234-1234-123456789012',
      });
      expect(actual.provider).toBe('cloudflare-containers');
    }
  );

  it.each([
    { SANDBOX_SELECTION_IDS: undefined },
    { SANDBOX_SELECTION_IDS: '' },
    { SANDBOX_SELECTION_IDS: 'other-org' },
    { SANDBOX_SELECTION_IDS: '', NODE_ENV: 'development' },
  ])('disables selection without the owner allowlist: %j', overrides => {
    const env = { ...configured, ...overrides } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities).toMatchObject({ enabled: false, options: [] });
    // The default stays visible so the UI can say where sessions run.
    expect(capabilities.defaultDestination).toEqual(
      getSandboxSelectionCapabilities({ ...env, SANDBOX_SELECTION_IDS: '*' } as Env, owner)
        .defaultDestination
    );
    for (const preset of sandboxAllocationSchema.options) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow('not enabled');
    }
  });

  it('keeps the trigger-only allocation out of the manual picker', () => {
    const capabilities = getSandboxSelectionCapabilities(configured as Env, owner);
    expect(availableOptions(capabilities)).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
    ]);
    expect(
      capabilities.options.some(
        option => getSandboxAllocation(option.allocation) === 'isolated-standard'
      )
    ).toBe(false);
  });

  it('reports the native small allocation and gates larger containers on enrollment', () => {
    const missingContainers = { ...configured } as Env;
    expect(availableOptions(getSandboxSelectionCapabilities(missingContainers, owner))).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
    ]);

    const enrolledContainers = {
      ...configured,
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    expect(availableOptions(getSandboxSelectionCapabilities(enrolledContainers, owner))).toEqual([
      getSandboxAllocationRequest('cloudflare-shared'),
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-containers-standard-4'),
    ]);
  });

  it('enables personal selection when the user is listed', () => {
    const env = { ...configured, SANDBOX_SELECTION_IDS: owner.userId } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, { userId: owner.userId });
    expect(capabilities.enabled).toBe(true);
    expect(availableOptions(capabilities)).toHaveLength(2);
  });

  it('enables personal selection for wildcard rollouts', () => {
    const env = { ...configured, SANDBOX_SELECTION_IDS: '*' } as Env;
    expect(getSandboxSelectionCapabilities(env, { userId: owner.userId }).enabled).toBe(true);
  });

  it('does not enable personal selection from an organization-only allowlist', () => {
    expect(
      getSandboxSelectionCapabilities(configured as Env, { userId: owner.userId })
    ).toMatchObject({ enabled: false, options: [] });
  });

  it('enables an organization session when the user is listed', () => {
    const env = { ...configured, SANDBOX_SELECTION_IDS: owner.userId } as Env;
    expect(getSandboxSelectionCapabilities(env, owner).enabled).toBe(true);
  });

  it('enables selection for an enrolled owner', () => {
    const env = {
      ...configured,
      VERCEL_SANDBOX_ORG_IDS: '',
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities.enabled).toBe(true);
    expect(availableOptions(capabilities)).toHaveLength(3);
    expect(capabilities.options.every(option => !('available' in option))).toBe(true);
    expect(JSON.stringify(capabilities)).not.toContain('test-token');
    for (const preset of sandboxAllocationSchema.options) {
      if (preset.startsWith('vercel-'))
        expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
          'Configure Vercel BYOC'
        );
      else expect(() => assertSandboxAllocationAvailable(env, owner, preset)).not.toThrow();
    }
  });

  it.each(Object.keys(configured).filter(key => key.startsWith('VERCEL_')))(
    'disables only Vercel when operational configuration %s is absent',
    key => {
      const env = { ...configured, [key]: undefined } as Env;
      const capabilities = getSandboxSelectionCapabilities(env, owner);
      expect(capabilities.enabled).toBe(true);
      expect(availableOptions(capabilities)).toEqual([
        getSandboxAllocationRequest('cloudflare-containers-standard-3'),
        getSandboxAllocationRequest('cloudflare-shared'),
      ]);
      for (const preset of ['vercel-small', 'vercel-large'] as const) {
        expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
          'Configure Vercel BYOC'
        );
      }
      expect(() => assertSandboxAllocationAvailable(env, owner, 'isolated-standard')).not.toThrow();
    }
  );

  it('enables the picker from BYOC enrollment without the selection allowlist and keeps Cloudflare default', () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: '',
      BYOC_VERCEL_IDS: owner.orgId,
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(capabilities.enabled).toBe(true);
    expect(capabilities.defaultDestination).toEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(availableOptions(capabilities)).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
      getSandboxAllocationRequest('vercel-small'),
      getSandboxAllocationRequest('vercel-large'),
    ]);
    for (const preset of ['cloudflare-single', 'cloudflare-shared'] as const) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).not.toThrow();
    }
    expect(() => assertSandboxAllocationAvailable(env, owner, 'vercel-small')).not.toThrow();
  });

  it('resolves ready BYOC credentials without forcing Vercel over the Cloudflare default', async () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: '',
      BYOC_VERCEL_IDS: owner.orgId,
    } as Env;

    const readiness = await resolveVercelSelectionReadiness(env, owner);
    expect(readiness).toEqual({});

    const capabilities = getSandboxSelectionCapabilities(env, owner, readiness);
    expect(capabilities.defaultDestination).toEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(isSandboxAllocationAvailable(capabilities, 'vercel-small')).toBe(true);
    expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-containers-standard-3')).toBe(
      true
    );
  });

  it.each([
    ['pending', { setupStatus: 'pending' }],
    ['building', { setupStatus: 'building' }],
    ['failed', { setupStatus: 'failed' }],
  ] as const)(
    'disables only Vercel when BYOC credential setup is %s',
    async (_status, enrollment) => {
      const env = {
        ...configured,
        SANDBOX_SELECTION_IDS: owner.orgId,
        BYOC_VERCEL_IDS: owner.orgId,
      } as Env;
      fetchByocVercelEnrollmentMock.mockResolvedValue({
        organizationId: owner.orgId,
        credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4ac',
        ...enrollment,
      });

      const readiness = await resolveVercelSelectionReadiness(env, owner);
      expect(readiness.vercelUnavailableReason).toBeTruthy();

      const capabilities = getSandboxSelectionCapabilities(env, owner, readiness);
      expect(capabilities.defaultDestination).toEqual(
        getSandboxAllocationRequest('cloudflare-containers-standard-3')
      );
      expect(availableOptions(capabilities)).toEqual([
        getSandboxAllocationRequest('cloudflare-containers-standard-3'),
        getSandboxAllocationRequest('cloudflare-shared'),
      ]);
      expect(isSandboxAllocationAvailable(capabilities, 'vercel-small')).toBe(false);
      expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-shared')).toBe(true);
    }
  );

  it('disables only Vercel when BYOC credentials are missing', async () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: owner.orgId,
      BYOC_VERCEL_IDS: owner.orgId,
    } as Env;
    fetchByocVercelEnrollmentMock.mockRejectedValue(new ByocCredentialMissingError(owner.orgId));

    const readiness = await resolveVercelSelectionReadiness(env, owner);
    const capabilities = getSandboxSelectionCapabilities(env, owner, readiness);
    expect(readiness.vercelUnavailableReason).toBeTruthy();
    expect(isSandboxAllocationAvailable(capabilities, 'vercel-small')).toBe(false);
    expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-shared')).toBe(true);
  });

  it('disables only Vercel when BYOC credential lookup fails', async () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: owner.orgId,
      BYOC_VERCEL_IDS: owner.orgId,
    } as Env;
    fetchByocVercelEnrollmentMock.mockRejectedValue(new Error('credential service unavailable'));

    const capabilities = getSandboxSelectionCapabilities(env, owner, {
      ...(await resolveVercelSelectionReadiness(env, owner)),
    });
    expect(isSandboxAllocationAvailable(capabilities, 'vercel-small')).toBe(false);
    expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-containers-standard-3')).toBe(
      true
    );
  });

  it('keeps Vercel statically selectable for launch even when credentials are not ready', () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: owner.orgId,
      BYOC_VERCEL_IDS: owner.orgId,
    } as Env;
    expect(() => assertSandboxAllocationAvailable(env, owner, 'vercel-small')).not.toThrow();
  });

  it('uses the personal BYOC credential lookup without platform credentials', async () => {
    const env = { SANDBOX_SELECTION_IDS: '*', BYOC_VERCEL_IDS: '*' } as Env;
    const personal = { userId: owner.userId };

    await expect(resolveVercelSelectionReadiness(env, personal)).resolves.toEqual({});
    expect(fetchByocVercelEnrollmentForUserMock).toHaveBeenCalledWith(env, owner.userId);
    expect(fetchByocVercelEnrollmentMock).not.toHaveBeenCalled();

    const capabilities = getSandboxSelectionCapabilities(env, personal);
    expect(capabilities.defaultDestination).toEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(availableOptions(capabilities)).toContainEqual(
      getSandboxAllocationRequest('vercel-small')
    );
  });

  it('fails Vercel closed for enforced organization billing', () => {
    const env = {
      ...configured,
      CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
      CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: owner.orgId,
    } as Env;
    const capabilities = getSandboxSelectionCapabilities(env, owner);
    expect(availableOptions(capabilities)).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
    ]);
    for (const preset of ['vercel-small', 'vercel-large'] as const) {
      expect(() => assertSandboxAllocationAvailable(env, owner, preset)).toThrow(
        'Configure Vercel BYOC'
      );
    }
    expect(() => assertSandboxAllocationAvailable(env, owner, 'cloudflare-single')).not.toThrow();
  });

  it('offers every Cloudflare containers size only to enrolled owners', () => {
    const enrolled = {
      ...configured,
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    const options = availableOptions(getSandboxSelectionCapabilities(enrolled, owner));
    expect(options).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-3'));
    expect(options).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-4'));
    for (const allocation of [
      'cloudflare-containers-standard-3',
      'cloudflare-containers-standard-4',
    ] as const) {
      expect(() => assertSandboxAllocationAvailable(enrolled, owner, allocation)).not.toThrow();
    }

    const unenrolled = { ...configured, CLOUDFLARE_CONTAINERS_ORG_IDS: 'other-org' } as Env;
    const unenrolledOptions = availableOptions(getSandboxSelectionCapabilities(unenrolled, owner));
    expect(unenrolledOptions).toContainEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(unenrolledOptions).not.toContainEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-4')
    );
    expect(() =>
      assertSandboxAllocationAvailable(unenrolled, owner, 'cloudflare-containers-standard-3')
    ).not.toThrow();
    expect(() =>
      assertSandboxAllocationAvailable(unenrolled, owner, 'cloudflare-containers-standard-4')
    ).toThrow('not enabled for this account');
  });

  it('admits personal Cloudflare containers enrollment only for the wildcard', () => {
    const wildcard = {
      ...configured,
      SANDBOX_SELECTION_IDS: '*',
      CLOUDFLARE_CONTAINERS_ORG_IDS: '*',
    } as Env;
    expect(
      availableOptions(getSandboxSelectionCapabilities(wildcard, { userId: owner.userId }))
    ).toContainEqual(getSandboxAllocationRequest('cloudflare-containers-standard-4'));

    const orgOnly = {
      ...configured,
      SANDBOX_SELECTION_IDS: '*',
      CLOUDFLARE_CONTAINERS_ORG_IDS: owner.orgId,
    } as Env;
    const orgOnlyCapabilities = getSandboxSelectionCapabilities(orgOnly, {
      userId: owner.userId,
    });
    expect(availableOptions(orgOnlyCapabilities)).not.toContainEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-4')
    );
    const containers = orgOnlyCapabilities.options.find(
      option => getSandboxAllocation(option.allocation) === 'cloudflare-containers-standard-4'
    );
    expect(containers?.unavailableReason).toBeTruthy();
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
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(options).toContainEqual(capabilities.defaultDestination);
    expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-containers-standard-4')).toBe(
      true
    );
  });

  it('reports a repository-unavailable reason while keeping a provider-available option listed', () => {
    const gitlab = getSandboxSelectionCapabilities(
      { ...configured, BYOC_VERCEL_IDS: owner.orgId } as Env,
      owner,
      {
        repositoryType: 'gitlab',
      }
    );
    const vercel = gitlab.options.find(
      option => getSandboxAllocation(option.allocation) === 'vercel-small'
    );
    expect(vercel?.unavailableReason).toBeUndefined();
    expect(vercel?.repositoryUnavailableReason).toBeTruthy();
    expect(isSandboxAllocationAvailable(gitlab, 'vercel-small')).toBe(false);

    const github = getSandboxSelectionCapabilities(
      { ...configured, BYOC_VERCEL_IDS: owner.orgId } as Env,
      owner,
      {
        repositoryType: 'github',
      }
    );
    expect(isSandboxAllocationAvailable(github, 'vercel-small')).toBe(true);
  });

  it('marks Vercel unavailable for review and remediation origins while Cloudflare stays eligible', () => {
    for (const capability of ['review', 'remediation'] as const) {
      const capabilities = getSandboxSelectionCapabilities(configured as Env, owner, {
        capability,
      });
      const vercel = capabilities.options.find(
        option => getSandboxAllocation(option.allocation) === 'vercel-small'
      );
      expect(vercel?.unavailableReason).toBeTruthy();
      expect(vercel?.repositoryUnavailableReason).toBeUndefined();
      expect(isSandboxAllocationAvailable(capabilities, 'vercel-small')).toBe(false);
      expect(isSandboxAllocationAvailable(capabilities, 'cloudflare-single')).toBe(true);
    }
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

describe('sandbox selection API', () => {
  const caller = (env: Env) =>
    appRouter.createCaller({
      env,
      userId: owner.userId,
      authToken: 'test-token',
      request: new Request('http://localhost'),
    } as TRPCContext);

  it('offers both providers when BYOC enrollment has ready credentials', async () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: '',
      BYOC_VERCEL_IDS: '*',
    } as Env;

    const result = await caller(env).getSandboxSelectionOptions({});
    expect(result.enabled).toBe(true);
    expect(result.defaultDestination).toEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(availableOptions(result)).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
      getSandboxAllocationRequest('vercel-small'),
      getSandboxAllocationRequest('vercel-large'),
    ]);
  });

  it('keeps Cloudflare choices and disables only Vercel when credentials are not ready', async () => {
    const env = {
      ...configured,
      SANDBOX_SELECTION_IDS: '',
      BYOC_VERCEL_IDS: '*',
    } as Env;
    fetchByocVercelEnrollmentForUserMock.mockResolvedValue({
      userId: owner.userId,
      credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4ad',
      setupStatus: 'pending',
    });

    const result = await caller(env).getSandboxSelectionOptions({});
    expect(result.defaultDestination).toEqual(
      getSandboxAllocationRequest('cloudflare-containers-standard-3')
    );
    expect(availableOptions(result)).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
    ]);
    const vercel = result.options.find(
      option => getSandboxAllocation(option.allocation) === 'vercel-small'
    );
    expect(vercel?.unavailableReason).toBeTruthy();
  });
});
