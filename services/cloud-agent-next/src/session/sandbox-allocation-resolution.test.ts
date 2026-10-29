import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type * as CloudAgentProfileModule from '@kilocode/cloud-agent-profile';
import type * as ByocCredentialResolverModule from '../byoc/vercel-credential-resolver.js';
import type { Env } from '../types.js';
import {
  assertEnvironmentSupportsSandbox,
  requestedSandboxAllocation,
  resolveSavedSandboxAllocation,
  withSavedSandboxAllocation,
} from './sandbox-allocation-resolution.js';
import type { SessionCreateRequest, SessionRepositoryRequest } from './session-requests.js';

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

// Selection is enabled and Vercel is configured. Cloudflare containers are not
// enrolled, and credential containment is on by default.
const selectionEnv = Object.assign({} as Env, {
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
const enrolledEnv = { ...selectionEnv, CLOUDFLARE_CONTAINERS_ORG_IDS: 'org-id' } as Env;
const withoutVercelEnv = { SANDBOX_SELECTION_IDS: 'org-id' } as Env;
const disabledEnv = {} as Env;

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
    repositoryType?: 'github' | 'gitlab' | 'bitbucket';
    capability?: 'review' | 'remediation';
    environmentAllocation?: string;
    environment?: typeof v1 | typeof v2;
    readiness?: { vercelUnavailableReason?: string };
  } = {}
) {
  return resolveSavedSandboxAllocation({
    db,
    env: args.env ?? env,
    owner,
    repositoryType: args.repositoryType ?? 'github',
    ...(args.capability ? { capability: args.capability } : {}),
    ...(args.environmentAllocation ? { environmentAllocation: args.environmentAllocation } : {}),
    environment: args.environment ?? null,
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
      resolve({ env: enrolledEnv, environmentAllocation: 'cloudflare-containers-standard-4' })
    ).resolves.toBe('cloudflare-containers-standard-4');
  });

  it('falls back to the repository override when the environment allocation is unavailable', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-single',
    });

    await expect(
      resolve({ env: withoutVercelEnv, environmentAllocation: 'vercel-large' })
    ).resolves.toBe('cloudflare-single');
  });

  it('prefers the eligible repository override over the context default', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-4',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ env: enrolledEnv })).resolves.toBe('cloudflare-containers-standard-4');
  });

  it('falls back to the context default when the repository override is unavailable', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-small',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ env: withoutVercelEnv })).resolves.toBe('cloudflare-single');
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

  it('skips a saved containers size that the picker does not offer', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-containers-standard-4',
      contextAllocation: 'vercel-small',
    });

    await expect(resolve()).resolves.toBeUndefined();
  });

  it('skips a saved Vercel choice for a GitLab repository', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'vercel-large',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ repositoryType: 'gitlab' })).resolves.toBe('cloudflare-single');
  });

  it.each(['review', 'remediation'] as const)(
    'skips a saved Vercel choice for a %s origin',
    async capability => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'vercel-small',
        contextAllocation: 'cloudflare-containers-standard-4',
      });

      await expect(resolve({ env: enrolledEnv, capability })).resolves.toBe(
        'cloudflare-containers-standard-4'
      );
    }
  );

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

    await expect(resolve({ env: byocEnv })).resolves.toBe('cloudflare-single');
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

    await expect(resolve({ env: byocEnv })).resolves.toBe('cloudflare-shared');
  });

  it('keeps an enrolled saved Cloudflare allocation without reading BYOC credentials', async () => {
    const byocEnv = { ...env, BYOC_VERCEL_IDS: owner.orgId } as Env;
    fetchByocVercelEnrollmentMock.mockRejectedValue(
      new Error('Vercel credentials must not be consulted for Cloudflare')
    );
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-shared',
      contextAllocation: 'vercel-small',
    });

    await expect(resolve({ env: byocEnv })).resolves.toBe('cloudflare-shared');
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

  it('does not read settings when the owner cannot select a sandbox', async () => {
    await expect(resolve({ env: disabledEnv })).resolves.toBeUndefined();
    expect(getSandboxAllocationCandidatesMock).not.toHaveBeenCalled();
  });

  it('reads only the context setting for a Bitbucket repository', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve({ repositoryType: 'bitbucket' })).resolves.toBe('cloudflare-single');
    expect(getSandboxAllocationCandidatesMock).toHaveBeenCalledWith(
      db,
      { type: 'organization', id: 'org-id' },
      undefined
    );
  });

  describe('for an environment with several repositories', () => {
    it('skips a shared owner default and resolves the next isolated candidate', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'cloudflare-shared',
        contextAllocation: 'cloudflare-single',
      });

      await expect(resolve({ env: enrolledEnv, environment: v2 })).resolves.toBe(
        'cloudflare-single'
      );
    });

    it('resolves nothing when every owner default is shared or Vercel', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'vercel-small',
        contextAllocation: 'cloudflare-shared',
      });

      await expect(resolve({ env: enrolledEnv, environment: v2 })).resolves.toBeUndefined();
    });

    it('does not skip the environment allocation, so the start fails with the reason', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        contextAllocation: 'cloudflare-single',
      });

      const allocation = await resolve({
        env: enrolledEnv,
        environment: v2,
        environmentAllocation: 'cloudflare-shared',
      });

      expect(allocation).toBe('cloudflare-shared');
      expect(() =>
        assertEnvironmentSupportsSandbox({ environment: v2, allocation, contained: true })
      ).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
    });

    it('keeps a shared owner default for a V1 environment', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'cloudflare-shared',
        contextAllocation: 'cloudflare-single',
      });

      await expect(resolve({ env: enrolledEnv, environment: v1 })).resolves.toBe(
        'cloudflare-shared'
      );
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
  const args = { db, env: enrolledEnv, userId: 'oauth/user' };

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
        contained: true,
      })
    ).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('keeps a shared owner default for a V1 environment', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-shared',
    });

    const resolved = await withSavedSandboxAllocation(request({ environment: v1 }), args);

    expect(requestedSandboxAllocation(resolved)).toBe('cloudflare-shared');
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
  ] as const)(
    'lets a V2 environment start on %s with contained credentials',
    (_name, allocation) => {
      expect(() =>
        assertEnvironmentSupportsSandbox({ environment: v2, allocation, contained: true })
      ).not.toThrow();
    }
  );

  it.each([
    ['the shared sandbox', 'cloudflare-shared', 'shared sandbox'],
    ['a small Vercel sandbox', 'vercel-small', 'Vercel sandbox'],
    ['a large Vercel sandbox', 'vercel-large', 'Vercel sandbox'],
  ] as const)(
    'fails a V2 environment on %s with a specific reason',
    (_name, allocation, reason) => {
      expect(() =>
        assertEnvironmentSupportsSandbox({ environment: v2, allocation, contained: true })
      ).toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', message: expect.stringContaining(reason) })
      );
    }
  );

  it('fails a V2 environment whose credentials would be direct', () => {
    expect(() =>
      assertEnvironmentSupportsSandbox({ environment: v2, allocation: undefined, contained: false })
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('contained credentials'),
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
      for (const contained of [true, false]) {
        expect(() =>
          assertEnvironmentSupportsSandbox({ environment, allocation, contained })
        ).not.toThrow();
      }
    }
  });
});
