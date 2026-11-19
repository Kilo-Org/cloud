import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type * as CloudAgentProfileModule from '@kilocode/cloud-agent-profile';
import type * as ByocCredentialResolverModule from '../byoc/vercel-credential-resolver.js';
import type { Env } from '../types.js';
import { vercelRuntimeBaseDigest } from '../byoc/vercel-runtime-base.js';
import {
  assertEnvironmentSupportsSandbox,
  requestedSandboxAllocation,
  resolveSavedSandboxAllocation,
  withSavedSandboxAllocation,
} from './sandbox-allocation-resolution.js';
import type {
  SessionCreateRequest,
  SessionRepositoryRequest,
  SessionRuntimeIntent,
} from './session-requests.js';

const { getSandboxAllocationCandidatesMock } = vi.hoisted(() => ({
  getSandboxAllocationCandidatesMock: vi.fn(),
}));

const { fetchByocVercelEnrollmentMock, fetchByocVercelEnrollmentForUserMock } = vi.hoisted(() => ({
  fetchByocVercelEnrollmentMock: vi.fn(),
  fetchByocVercelEnrollmentForUserMock: vi.fn(),
}));

vi.mock('@kilocode/cloud-agent-profile', async importOriginal => ({
  ...(await importOriginal<typeof CloudAgentProfileModule>()),
  getSandboxAllocationCandidates: getSandboxAllocationCandidatesMock,
}));
vi.mock('../byoc/vercel-credential-resolver.js', async importActual => {
  const actual = await importActual<typeof ByocCredentialResolverModule>();
  return {
    ...actual,
    fetchByocVercelEnrollment: fetchByocVercelEnrollmentMock,
    fetchByocVercelEnrollmentForUser: fetchByocVercelEnrollmentForUserMock,
  };
});

const db = {} as WorkerDb;
const owner = { userId: 'oauth/user', orgId: 'org-id' };

// Selection is enabled and Vercel BYOC credentials are configured.
const selectionEnv = Object.assign({} as Env, {
  CONTAINER_USAGE_METER: { getBillingMode: vi.fn().mockResolvedValue('shadow') },
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
const env = selectionEnv as Env;
const withoutVercelEnv = { SANDBOX_SELECTION_IDS: 'org-id' } as Env;
const disabledEnv = {
  CONTAINER_USAGE_METER: { getBillingMode: vi.fn().mockResolvedValue('shadow') },
} as unknown as Env;

const v1 = {
  environmentId: '123e4567-e89b-12d3-a456-426614174099',
  owner: { type: 'user' as const, id: 'user-1' },
  configurationRevision: 1,
  repository: { platform: 'github' as const, repoFullName: 'acme/repo' },
};
const v2 = {
  environmentId: v1.environmentId,
  owner: v1.owner,
  configurationRevision: 1,
  repositories: [
    {
      identity: { platform: 'github' as const, repoFullName: 'acme/repo' },
      repoFullName: 'acme/repo',
      leaf: 'repo',
    },
    {
      identity: { platform: 'github' as const, repoFullName: 'acme/api' },
      repoFullName: 'acme/api',
      leaf: 'api',
    },
  ],
};

function resolve(
  args: {
    env?: Env;
    repositoryType?: 'github' | 'gitlab' | 'bitbucket' | 'git';
    capability?: 'review' | 'remediation';
    environmentAllocation?: string;
    readiness?: { vercelUnavailableReason?: string };
  } = {}
) {
  return resolveSavedSandboxAllocation({
    db,
    env: args.env ?? env,
    owner,
    repositoryType: args.repositoryType ?? 'git',
    ...(args.capability ? { capability: args.capability } : {}),
    ...(args.environmentAllocation ? { environmentAllocation: args.environmentAllocation } : {}),
    ...(args.readiness ? { readiness: args.readiness } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSandboxAllocationCandidatesMock.mockResolvedValue({});
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

describe('resolveSavedSandboxAllocation', () => {
  it('prefers the eligible environment allocation over the repository override', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-single',
      contextAllocation: 'cloudflare-single',
    });

    await expect(
      resolve({ env: env, environmentAllocation: 'cloudflare-containers-standard-4' })
    ).resolves.toBe('cloudflare-containers-standard-4');
  });

  it('falls back to the repository override when the environment allocation is unavailable', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-single',
    });

    await expect(
      resolve({ env: withoutVercelEnv, environmentAllocation: 'vercel-large' })
    ).resolves.toBeUndefined();
  });

  it('prefers the eligible repository override over the context default', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-4',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ env: env })).resolves.toBe('cloudflare-containers-standard-4');
  });

  it('falls back to the context default when the repository override is unavailable', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-small',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ env: withoutVercelEnv })).resolves.toBeUndefined();
  });

  it('applies a saved native small sandbox for an owner outside the containers enrollment', async () => {
    // The picker offers the native size in place of Cloudflare sandbox small, so
    // a person can save it; session start must then honor it.
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-3',
      contextAllocation: 'vercel-small',
    });

    await expect(resolve()).resolves.toBe('cloudflare-containers-standard-3');
  });

  it('keeps a saved larger containers size', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-4',
      contextAllocation: 'vercel-small',
    });

    await expect(resolve()).resolves.toBe('cloudflare-containers-standard-4');
  });

  it('applies a saved size from billing enrollment without the selection allowlist', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-containers-standard-4',
    });
    const getBillingMode = vi.fn().mockResolvedValue('paid');

    await expect(
      resolve({
        env: {
          CONTAINER_USAGE_METER: { getBillingMode },
        } as unknown as Env,
      })
    ).resolves.toBe('cloudflare-containers-standard-4');
    expect(getBillingMode).toHaveBeenCalledWith({
      service: 'cloud-agent-next-sandbox-containers-standard4',
      subject: { type: 'org', id: owner.orgId },
    });
  });

  it('skips an unpaid saved size and keeps the paid context default', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-3',
      contextAllocation: 'cloudflare-containers-standard-4',
    });
    const getBillingMode = vi.fn(async ({ service }: { service: string }) =>
      service === 'cloud-agent-next-sandbox-containers-standard4' ? 'paid' : 'shadow'
    );

    await expect(
      resolve({ env: { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env })
    ).resolves.toBe('cloudflare-containers-standard-4');
  });

  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'keeps a ready BYOC Vercel choice for managed %s repositories',
    async repositoryType => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'vercel-large',
        contextAllocation: 'cloudflare-single',
      });

      await expect(
        resolve({ repositoryType, env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env })
      ).resolves.toBe('vercel-large');
    }
  );

  it.each(['git'] as const)('keeps a ready BYOC Vercel choice for %s', async repositoryType => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-large',
      contextAllocation: 'cloudflare-single',
    });

    await expect(
      resolve({ repositoryType, env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env })
    ).resolves.toBe('vercel-large');
  });

  it('keeps a saved Vercel choice for a remediation origin on the current base', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-small',
      contextAllocation: 'cloudflare-containers-standard-4',
    });
    fetchByocVercelEnrollmentMock.mockResolvedValue({
      organizationId: owner.orgId,
      credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4aa',
      setupStatus: 'ready',
      runtimeDigest: await vercelRuntimeBaseDigest(),
    });

    await expect(
      resolve({ env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env, capability: 'remediation' })
    ).resolves.toBe('vercel-small');
  });

  it.each([
    ['an older base digest', { runtimeDigest: 'downloaded-base-v1:older' }],
    ['no stored digest', { runtimeDigest: null }],
    ['an older web response', {}],
  ] as const)(
    'skips a saved Vercel choice for a remediation origin with %s',
    async (_name, fields) => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'vercel-small',
        contextAllocation: 'cloudflare-containers-standard-4',
      });
      fetchByocVercelEnrollmentMock.mockResolvedValue({
        organizationId: owner.orgId,
        credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4aa',
        setupStatus: 'ready',
        ...fields,
      });

      await expect(
        resolve({ env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env, capability: 'remediation' })
      ).resolves.toBe('cloudflare-containers-standard-4');
    }
  );

  it('keeps a saved Vercel choice for a normal session on an older base', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({ contextAllocation: 'vercel-small' });
    fetchByocVercelEnrollmentMock.mockResolvedValue({
      organizationId: owner.orgId,
      credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4aa',
      setupStatus: 'ready',
      runtimeDigest: 'downloaded-base-v1:older',
    });

    await expect(resolve({ env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env })).resolves.toBe(
      'vercel-small'
    );
  });

  it('keeps a saved Vercel choice for a BYOC-enrolled owner with ready credentials', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({ contextAllocation: 'vercel-small' });

    await expect(resolve({ env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env })).resolves.toBe(
      'vercel-small'
    );
    expect(fetchByocVercelEnrollmentMock).toHaveBeenCalledWith(
      { ...env, BYOC_VERCEL_IDS: owner.orgId },
      owner.orgId
    );
  });

  it('resolves a saved Vercel choice from BYOC enrollment without the selection allowlist', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({ contextAllocation: 'vercel-small' });

    await expect(
      resolve({ env: { ...env, SANDBOX_SELECTION_IDS: '', BYOC_VERCEL_IDS: owner.orgId } as Env })
    ).resolves.toBe('vercel-small');
  });

  it.each([
    ['pending', { setupStatus: 'pending' }],
    ['building', { setupStatus: 'building' }],
    ['failed', { setupStatus: 'failed' }],
  ] as const)('skips a saved Vercel choice when setup is %s', async (_status, enrollment) => {
    const byocEnv = { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env;
    fetchByocVercelEnrollmentMock.mockResolvedValue({
      organizationId: owner.orgId,
      credentialId: 'f47ac10b-58cc-4372-a567-0e02b2c3d4ac',
      ...enrollment,
    });
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-small',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ env: byocEnv })).resolves.toBeUndefined();
  });

  it('skips a saved Vercel choice when credentials are missing', async () => {
    const byocEnv = { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env;
    fetchByocVercelEnrollmentMock.mockRejectedValue(new Error('not found'));
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'vercel-small',
    });

    await expect(resolve({ env: byocEnv })).resolves.toBeUndefined();
  });

  it('skips a saved Vercel choice when credential lookup fails', async () => {
    const byocEnv = { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env;
    fetchByocVercelEnrollmentMock.mockRejectedValue(new Error('credential service unavailable'));
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-small',
      contextAllocation: 'cloudflare-shared',
    });

    await expect(resolve({ env: byocEnv })).resolves.toBeUndefined();
  });

  it('keeps an enrolled saved Cloudflare allocation without reading BYOC credentials', async () => {
    const byocEnv = { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env;
    fetchByocVercelEnrollmentMock.mockRejectedValue(
      new Error('Vercel credentials must not be consulted for Cloudflare')
    );
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-4',
      contextAllocation: 'vercel-small',
    });

    await expect(resolve({ env: byocEnv })).resolves.toBe('cloudflare-containers-standard-4');
    expect(fetchByocVercelEnrollmentMock).not.toHaveBeenCalled();
  });

  it('reuses resolved readiness without reading credentials again', async () => {
    const byocEnv = { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env;
    getSandboxAllocationCandidatesMock.mockResolvedValue({ contextAllocation: 'vercel-small' });

    await expect(
      resolve({
        env: byocEnv,
        readiness: { vercelUnavailableReason: 'Vercel compute setup is not ready' },
      })
    ).resolves.toBeUndefined();
    expect(fetchByocVercelEnrollmentMock).not.toHaveBeenCalled();
  });

  it('returns nothing when no saved setting resolves', async () => {
    await expect(resolve()).resolves.toBeUndefined();
  });

  it('skips a saved value that is not a selectable allocation', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'made-up-allocation',
    });

    await expect(resolve()).resolves.toBeUndefined();
  });

  it.each([{}, { contextAllocation: 'retired-allocation' }])(
    'does not check billing when no selectable saved setting exists: %j',
    async candidates => {
      getSandboxAllocationCandidatesMock.mockResolvedValue(candidates);
      const getBillingMode = vi.fn().mockRejectedValue(new Error('unavailable'));

      await expect(
        resolve({ env: { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env })
      ).resolves.toBeUndefined();
      expect(getBillingMode).not.toHaveBeenCalled();
    }
  );

  it('skips a saved size when the owner cannot select a sandbox', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-containers-standard-4',
    });

    await expect(resolve({ env: disabledEnv })).resolves.toBeUndefined();
    expect(disabledEnv.CONTAINER_USAGE_METER.getBillingMode).toHaveBeenCalledTimes(2);
  });

  it('reports a billing failure instead of dropping a selectable saved size', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-containers-standard-4',
    });
    const getBillingMode = vi.fn().mockRejectedValue(new Error('unavailable'));

    await expect(
      resolve({ env: { CONTAINER_USAGE_METER: { getBillingMode } } as unknown as Env })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(getBillingMode).toHaveBeenCalledTimes(4);
  });

  it('reads only the context setting for a Bitbucket repository', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ repositoryType: 'bitbucket' })).resolves.toBeUndefined();
    expect(getSandboxAllocationCandidatesMock).toHaveBeenCalledWith(
      db,
      { type: 'organization', id: 'org-id' },
      undefined
    );
  });

  describe('retired allocations', () => {
    it('skips retired saved allocation keys', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'retired-allocation',
        contextAllocation: 'cloudflare-containers-standard-3',
      });
      await expect(resolve()).resolves.toBe('cloudflare-containers-standard-3');
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        contextAllocation: 'retired-allocation',
      });
      await expect(resolve()).resolves.toBeUndefined();
    });

    it.each(['cloudflare-single', 'cloudflare-shared', 'isolated-standard'] as const)(
      'skips saved %s and resolves the next native candidate',
      async repositoryAllocation => {
        getSandboxAllocationCandidatesMock.mockResolvedValue({
          repositoryAllocation,
          contextAllocation: 'cloudflare-containers-standard-4',
        });

        await expect(resolve()).resolves.toBe('cloudflare-containers-standard-4');
      }
    );

    it('skips a retired environment allocation', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        contextAllocation: 'cloudflare-containers-standard-3',
      });

      await expect(resolve({ environmentAllocation: 'cloudflare-shared' })).resolves.toBe(
        'cloudflare-containers-standard-3'
      );
    });

    it('resolves nothing when every owner default is retired', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'cloudflare-shared',
        contextAllocation: 'cloudflare-single',
      });

      await expect(resolve()).resolves.toBeUndefined();
    });
  });
});

describe('withSavedSandboxAllocation', () => {
  const repository: SessionRepositoryRequest = { type: 'github', repo: 'acme/repo' };
  const request = (overrides: Partial<SessionCreateRequest> = {}): SessionCreateRequest =>
    ({
      agent: { mode: 'code', model: 'kilo/test' },
      repository,
      options: { kilocodeOrganizationId: 'org-id' },
      ...overrides,
    }) as SessionCreateRequest;
  const args = { db, env: env, userId: 'oauth/user' };

  it('records the saved allocation on the request', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-4',
    });

    const resolved = await withSavedSandboxAllocation(request(), args);

    expect(resolved.savedSandboxAllocation).toBe('cloudflare-containers-standard-4');
    expect(requestedSandboxAllocation(resolved)).toBe('cloudflare-containers-standard-4');
  });

  it('records that nothing was saved, so a later call does not read settings again', async () => {
    const first = await withSavedSandboxAllocation(request(), args);
    const second = await withSavedSandboxAllocation(first, args);

    expect(first.savedSandboxAllocation).toBeNull();
    expect(second).toBe(first);
    expect(getSandboxAllocationCandidatesMock).toHaveBeenCalledTimes(1);
  });

  it('applies the environment allocation that preflight carried', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-single',
    });

    const resolved = await withSavedSandboxAllocation(
      request({ environmentSandboxAllocation: 'cloudflare-containers-standard-4' }),
      args
    );

    expect(requestedSandboxAllocation(resolved)).toBe('cloudflare-containers-standard-4');
  });

  it("keeps the client's choice and never reads settings", async () => {
    const explicit = request({ runtime: { sandboxAllocation: 'vercel-small' } });

    const resolved = await withSavedSandboxAllocation(explicit, args);

    expect(resolved).toBe(explicit);
    expect(requestedSandboxAllocation(resolved)).toBe('vercel-small');
    expect(getSandboxAllocationCandidatesMock).not.toHaveBeenCalled();
  });

  it('skips a shared owner default for an environment with several repositories', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-shared',
    });

    const resolved = await withSavedSandboxAllocation(request({ environment: v2 }), args);

    expect(requestedSandboxAllocation(resolved)).toBeUndefined();
  });

  it('keeps an explicit shared request for the start to reject', async () => {
    const explicit = request({
      environment: v2,
      runtime: { sandboxAllocation: 'cloudflare-shared' },
    });

    const resolved = await withSavedSandboxAllocation(explicit, args);

    expect(requestedSandboxAllocation(resolved)).toBe('cloudflare-shared');
    expect(() =>
      assertEnvironmentSupportsSandbox({
        environment: v2,
        allocation: requestedSandboxAllocation(resolved),
      })
    ).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('skips a retired shared owner default for a V1 environment', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-shared',
    });

    const resolved = await withSavedSandboxAllocation(request({ environment: v1 }), args);

    expect(resolved.savedSandboxAllocation).toBeNull();
    expect(requestedSandboxAllocation(resolved)).toBeUndefined();
  });

  describe('egress policy', () => {
    const vercelArgs = { ...args, env: { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env };
    const restricted: [string, SessionRuntimeIntent][] = [
      ['an allowlist', { egressMode: 'allowlist', egressAllowlist: ['example.com'] }],
      ['an egress audit', { egressAudit: true }],
    ];
    const environments = [
      ['V1', v1],
      ['V2', v2],
    ] as const;
    const restrictedCases = environments.flatMap(([version, environment]) =>
      restricted.map(([policy, runtime]) => [version, policy, environment, runtime] as const)
    );

    it.each(restrictedCases)(
      'skips a Vercel owner default for a %s environment with %s',
      async (_version, _policy, environment, runtime) => {
        getSandboxAllocationCandidatesMock.mockResolvedValue({
          repositoryAllocation: 'vercel-small',
          contextAllocation: 'cloudflare-containers-standard-4',
        });

        const resolved = await withSavedSandboxAllocation(
          request({ environment, runtime }),
          vercelArgs
        );

        expect(requestedSandboxAllocation(resolved)).toBe('cloudflare-containers-standard-4');
      }
    );

    it.each(restrictedCases)(
      'records no saved allocation when the only owner default is Vercel (%s environment, %s)',
      async (_version, _policy, environment, runtime) => {
        getSandboxAllocationCandidatesMock.mockResolvedValue({ contextAllocation: 'vercel-small' });

        const resolved = await withSavedSandboxAllocation(
          request({ environment, runtime }),
          vercelArgs
        );

        expect(resolved.savedSandboxAllocation).toBeNull();
      }
    );

    it.each(
      environments.flatMap(([version, environment]) =>
        [undefined, { egressMode: 'unrestricted', egressAudit: false } as const].map(
          runtime =>
            [
              version,
              runtime === undefined ? 'no policy' : 'an unrestricted policy',
              environment,
              runtime,
            ] as const
        )
      )
    )(
      'keeps a Vercel owner default for a %s environment with %s',
      async (_version, _policy, environment, runtime) => {
        getSandboxAllocationCandidatesMock.mockResolvedValue({
          repositoryAllocation: 'vercel-small',
          contextAllocation: 'cloudflare-containers-standard-4',
        });

        const resolved = await withSavedSandboxAllocation(
          request({ environment, ...(runtime ? { runtime } : {}) }),
          vercelArgs
        );

        expect(requestedSandboxAllocation(resolved)).toBe('vercel-small');
      }
    );

    it.each(restrictedCases)(
      "keeps the environment's own Vercel allocation for a %s environment with %s, for the start to reject",
      async (_version, _policy, environment, runtime) => {
        getSandboxAllocationCandidatesMock.mockResolvedValue({
          contextAllocation: 'cloudflare-containers-standard-4',
        });

        const resolved = await withSavedSandboxAllocation(
          request({ environment, environmentSandboxAllocation: 'vercel-small', runtime }),
          vercelArgs
        );

        expect(requestedSandboxAllocation(resolved)).toBe('vercel-small');
      }
    );
  });

  it('ignores saved settings for a code review origin', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-small',
      contextAllocation: 'cloudflare-containers-standard-4',
    });

    const resolved = await withSavedSandboxAllocation(request(), {
      ...args,
      billingOrigin: 'code-review',
    });

    expect(resolved.savedSandboxAllocation).toBeNull();
    expect(requestedSandboxAllocation(resolved)).toBeUndefined();
    expect(getSandboxAllocationCandidatesMock).not.toHaveBeenCalled();
  });
});

describe('assertEnvironmentSupportsSandbox', () => {
  it.each([
    ['the default isolated sandbox', undefined],
    ['isolated Cloudflare containers', 'cloudflare-containers-standard-3'],
    ['larger isolated Cloudflare containers', 'cloudflare-containers-standard-4'],
    ['a Cloudflare sandbox', 'cloudflare-single'],
    ['a small Vercel sandbox', 'vercel-small'],
    ['a large Vercel sandbox', 'vercel-large'],
  ] as const)('lets a V2 environment start on %s', (_name, allocation) => {
    expect(() => assertEnvironmentSupportsSandbox({ environment: v2, allocation })).not.toThrow();
  });

  it('fails a V2 environment on the shared sandbox with a specific reason', () => {
    expect(() =>
      assertEnvironmentSupportsSandbox({ environment: v2, allocation: 'cloudflare-shared' })
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('shared sandbox'),
      })
    );
  });

  it.each([
    undefined,
    'cloudflare-shared',
    'vercel-small',
    'cloudflare-containers-standard-3',
  ] as const)('never restricts a V1 environment or no environment (allocation %s)', allocation => {
    for (const environment of [v1, undefined]) {
      expect(() => assertEnvironmentSupportsSandbox({ environment, allocation })).not.toThrow();
    }
  });
});
