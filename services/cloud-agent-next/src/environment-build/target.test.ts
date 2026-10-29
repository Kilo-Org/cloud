import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import type { Env } from '../types.js';

const resolveSaved = vi.hoisted(() => vi.fn());
const fetchCredential = vi.hoisted(() => vi.fn());
const fetchEnrollment = vi.hoisted(() => vi.fn());
const fetchEnrollmentForUser = vi.hoisted(() => vi.fn());
const enrolledOwner = vi.hoisted(() => vi.fn());
const nativeEnrolled = vi.hoisted(() => vi.fn());

vi.mock('../session/sandbox-allocation-resolution.js', () => ({
  resolveSavedSandboxAllocation: resolveSaved,
}));
vi.mock('../byoc/vercel-credential-resolver.js', () => ({
  fetchByocVercelCredential: fetchCredential,
  fetchByocVercelEnrollment: fetchEnrollment,
  fetchByocVercelEnrollmentForUser: fetchEnrollmentForUser,
}));
vi.mock('../byoc/vercel-owner.js', () => ({
  enrolledByocVercelOwner: enrolledOwner,
}));
vi.mock('../agent-sandbox/cloudflare-containers/cloudflare-containers-runtime-config.js', () => ({
  isCloudflareContainersEnrolled: nativeEnrolled,
}));

import { resolveEnvironmentBuildTarget } from './target.js';

const OWNER = { type: 'organization' as const, id: '22222222-2222-4222-8222-222222222222' };
const REFERENCE: EnvironmentReference = {
  environmentId: 'environment-1',
  owner: OWNER,
  configurationRevision: 1,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
};
const CREDENTIAL_ID = '44444444-4444-4444-8444-444444444444';
const ENV = {
  BYOC_VERCEL_IDS: OWNER.id,
  SANDBOX_CONTAINERS: {},
  RUNTIME_STARTUP_MODE: 'downloaded',
  NATIVE_RUNTIME_IMAGE: 'runtime-free',
  RUNTIME_RELEASE_DESCRIPTOR: 'a'.repeat(64),
  RUNTIME_RELEASE_BUCKET: {},
} as unknown as Env;

function target(commands: string[] = []) {
  return resolveEnvironmentBuildTarget({
    env: ENV,
    db: {} as WorkerDb,
    reference: REFERENCE,
    repoFullName: 'acme/widgets',
    commands,
    sandboxAllocation: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeEnrolled.mockReturnValue(true);
  enrolledOwner.mockReturnValue({ organizationId: OWNER.id });
  fetchEnrollment.mockResolvedValue({
    credentialId: CREDENTIAL_ID,
    setupStatus: 'ready',
    buildGeneration: 'generation-1',
    runtimeBuildId: 'runtime-1',
    runtimeSnapshotId: 'snap-base',
  });
  fetchCredential.mockResolvedValue({
    credentialId: CREDENTIAL_ID,
    teamId: 'team-1',
    projectId: 'project-1',
    setupStatus: 'ready',
    buildGeneration: 'generation-1',
    runtimeBuildId: 'runtime-1',
    runtimeSnapshotId: 'snap-base',
  });
});

describe('resolveEnvironmentBuildTarget', () => {
  it('pins the BYOC credential, account and base snapshot of a saved Vercel allocation', async () => {
    resolveSaved.mockResolvedValue('vercel-small');
    await expect(target()).resolves.toEqual({
      ok: true,
      target: {
        provider: 'vercel',
        credentialId: CREDENTIAL_ID,
        teamId: 'team-1',
        projectId: 'project-1',
        runtimeBuildId: 'runtime-1',
        baseSnapshotId: 'snap-base',
        resources: { vcpus: 2, memory: 4096 },
      },
    });
  });

  it('falls back to the native builder when no saved allocation names a provider', async () => {
    resolveSaved.mockResolvedValue(undefined);
    await expect(target(['pnpm install'])).resolves.toEqual({
      ok: true,
      target: { provider: 'cloudflare-containers', instance: 'standard-4' },
    });
  });

  it('refuses the native builder when the runtime image is not downloaded/runtime-free', async () => {
    resolveSaved.mockResolvedValue(undefined);
    await expect(
      resolveEnvironmentBuildTarget({
        env: { ...ENV, RUNTIME_STARTUP_MODE: 'preinstalled' } as Env,
        db: {} as WorkerDb,
        reference: REFERENCE,
        repoFullName: 'acme/widgets',
        commands: ['pnpm install'],
        sandboxAllocation: null,
      })
    ).resolves.toEqual({
      ok: false,
      provider: 'cloudflare-containers',
      reason: 'Environment snapshots require the downloaded runtime-free image and runtime release',
    });
  });

  it('refuses a Vercel allocation when BYOC is not enabled', async () => {
    resolveSaved.mockResolvedValue('vercel-small');
    enrolledOwner.mockReturnValue(undefined);
    await expect(target()).resolves.toEqual({
      ok: false,
      provider: 'vercel',
      reason: 'Vercel BYOC is not enabled for this owner',
    });
  });

  it('refuses Vercel before setup is ready', async () => {
    resolveSaved.mockResolvedValue('vercel-small');
    fetchCredential.mockResolvedValue({
      credentialId: CREDENTIAL_ID,
      teamId: 'team-1',
      projectId: 'project-1',
      setupStatus: 'building',
      buildGeneration: 'generation-1',
      runtimeBuildId: null,
      runtimeSnapshotId: null,
    });
    await expect(target()).resolves.toEqual({
      ok: false,
      provider: 'vercel',
      reason: 'Vercel compute setup is not ready',
    });
  });
});
