import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type { Env } from '../types.js';
import {
  requestedSandboxAllocation,
  resolveSavedSandboxAllocation,
  withSavedSandboxAllocation,
} from './sandbox-allocation-resolution.js';
import type { SessionCreateRequest, SessionRepositoryRequest } from './session-requests.js';

const { getSandboxAllocationCandidatesMock } = vi.hoisted(() => ({
  getSandboxAllocationCandidatesMock: vi.fn(),
}));

vi.mock('@kilocode/cloud-agent-profile', () => ({
  getSandboxAllocationCandidates: getSandboxAllocationCandidatesMock,
}));

const db = {} as WorkerDb;
const owner = { userId: 'oauth/user', orgId: 'org-id' };

// Selection is enabled and Vercel is configured. Cloudflare containers are not
// enrolled, and credential containment is on by default.
const selectionEnv = {
  SANDBOX_SELECTION_IDS: 'org-id',
  VERCEL_TOKEN: 'test-token',
  VERCEL_TEAM_ID: 'team-id',
  VERCEL_PROJECT_ID: 'project-id',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build-id',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
} satisfies Partial<Env>;
const env = selectionEnv as Env;
const enrolledEnv = { ...selectionEnv, CLOUDFLARE_CONTAINERS_ORG_IDS: 'org-id' } as Env;
const withoutVercelEnv = { SANDBOX_SELECTION_IDS: 'org-id' } as Env;
const disabledEnv = {} as Env;

function resolve(
  args: {
    env?: Env;
    repositoryType?: 'github' | 'gitlab' | 'bitbucket';
    capability?: 'review' | 'remediation';
  } = {}
) {
  return resolveSavedSandboxAllocation({
    db,
    env: args.env ?? env,
    owner,
    repositoryType: args.repositoryType ?? 'github',
    ...(args.capability ? { capability: args.capability } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSandboxAllocationCandidatesMock.mockResolvedValue({});
});

describe('resolveSavedSandboxAllocation', () => {
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

    await expect(resolve()).resolves.toBe('vercel-small');
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

  it('keeps a saved Vercel choice when nothing restricts it', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({ contextAllocation: 'vercel-small' });

    await expect(resolve()).resolves.toBe('vercel-small');
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

  it('skips a retired shared repository allocation and uses the context default', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      repositoryAllocation: 'cloudflare-shared',
      contextAllocation: 'cloudflare-single',
    });

    await expect(resolve()).resolves.toBe('cloudflare-single');
  });

  it('uses the runtime default when the only saved allocation is shared', async () => {
    getSandboxAllocationCandidatesMock.mockResolvedValue({
      contextAllocation: 'cloudflare-shared',
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

  it("keeps the client's choice and never reads settings", async () => {
    const explicit = request({ runtime: { sandboxAllocation: 'vercel-small' } });

    const resolved = await withSavedSandboxAllocation(explicit, args);

    expect(resolved).toBe(explicit);
    expect(requestedSandboxAllocation(resolved)).toBe('vercel-small');
    expect(getSandboxAllocationCandidatesMock).not.toHaveBeenCalled();
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
