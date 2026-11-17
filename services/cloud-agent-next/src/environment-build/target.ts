import type { WorkerDb } from '@kilocode/db/client';
import type {
  EnvironmentReference,
  EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import {
  CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
  type CloudflareContainersInstance,
  getSandboxAllocationProvider,
  getSandboxAllocationResources,
  type SandboxAllocation,
  type VercelSandboxResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import { repoFullNameFromGitUrl } from '@kilocode/worker-utils/git-url';
import { z } from 'zod';
import {
  ByocCredentialMissingError,
  fetchByocVercelCredential,
  fetchByocVercelEnrollment,
  fetchByocVercelEnrollmentForUser,
  type ByocVercelCredentialFetchInput,
} from '../byoc/vercel-credential-resolver.js';
import { enrolledByocVercelOwner, type ByocVercelOwner } from '../byoc/vercel-owner.js';
import { vercelSnapshotBaseImage } from '../byoc/vercel-snapshot-compatibility.js';
import { resolveSavedSandboxAllocation } from '../session/sandbox-allocation-resolution.js';
import type { Env } from '../types.js';

/**
 * The provider and account a build was admitted against. Admission pins this in
 * the build input because saved allocation and BYOC setup can change without a
 * configuration revision; a running build must never switch accounts midway.
 */
const vercelBuilderInstanceSchema = z.enum(['vercel-small', 'vercel-large']);

export const environmentBuildTargetSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('cloudflare-containers'),
      instance: z.enum(['standard-3', 'standard-4']),
    })
    .strict(),
  z
    .object({
      provider: z.literal('vercel'),
      credentialId: z.uuid(),
      teamId: z.string().min(1),
      projectId: z.string().min(1),
      runtimeBuildId: z.string().min(1),
      baseSnapshotId: z.string().min(1),
      instance: vercelBuilderInstanceSchema,
    })
    .strict(),
]);
export type EnvironmentBuildTarget = z.infer<typeof environmentBuildTargetSchema>;
export type VercelBuildTarget = Extract<EnvironmentBuildTarget, { provider: 'vercel' }>;

/** The builder sandbox size of a pinned Vercel target. */
export function vercelBuilderResources(target: VercelBuildTarget): VercelSandboxResources {
  const resources = getSandboxAllocationResources(target.instance);
  if (resources === undefined) throw new Error('Vercel builder instance has no resources');
  return resources;
}

export type BuildTargetResolution =
  | { ok: true; target: EnvironmentBuildTarget }
  | { ok: false; provider: EnvironmentBuildTarget['provider'] | null; reason: string };

/** `standard-4` when setup commands exist, otherwise the default native instance. */
export function builderInstance(commands: readonly string[]): CloudflareContainersInstance {
  return commands.length > 0 ? 'standard-4' : CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE;
}

/** Snapshot enrollment is separate from the interactive session runtime cohort. */
export function builderRuntimeUnsupportedReason(
  env: Pick<
    Env,
    | 'RUNTIME_STARTUP_MODE'
    | 'NATIVE_RUNTIME_IMAGE'
    | 'RUNTIME_RELEASE_DESCRIPTOR'
    | 'RUNTIME_RELEASE_BUCKET'
  >
): string | null {
  return env.RUNTIME_STARTUP_MODE === 'downloaded' &&
    env.NATIVE_RUNTIME_IMAGE === 'runtime-free' &&
    env.RUNTIME_RELEASE_DESCRIPTOR &&
    env.RUNTIME_RELEASE_BUCKET
    ? null
    : 'Environment snapshots require the downloaded runtime-free image and runtime release';
}

/** Both providers run the downloaded builder, so the runtime release is still required. */
export function snapshotsRuntimeUnsupportedReason(
  env: Pick<Env, 'RUNTIME_RELEASE_DESCRIPTOR' | 'RUNTIME_RELEASE_BUCKET'>
): string | null {
  return env.RUNTIME_RELEASE_DESCRIPTOR && env.RUNTIME_RELEASE_BUCKET
    ? null
    : 'Environment snapshots require a runtime release';
}

function selectionOwner(reference: EnvironmentReference): { userId: string; orgId?: string } {
  return reference.owner.type === 'organization'
    ? { userId: '', orgId: reference.owner.id }
    : { userId: reference.owner.id };
}

type SelectionRepository = {
  identity: EnvironmentRepositoryIdentity;
  repoFullName: string;
};

/**
 * The repository whose saved allocation decides the target. A V1 build names its
 * one repository; a V2 build has every repository in the reference, and the
 * first one decides the allocation subject the same way a session does.
 */
function selectionRepository(
  reference: EnvironmentReference,
  repoFullName: string | undefined
): SelectionRepository | null {
  if (reference.repositories !== undefined) {
    const first = reference.repositories[0];
    return first === undefined
      ? null
      : { identity: first.identity, repoFullName: first.repoFullName };
  }
  return repoFullName === undefined ? null : { identity: reference.repository, repoFullName };
}

function allocationTarget(
  repository: SelectionRepository
): { platform: 'github' | 'gitlab'; fullName: string } | undefined {
  switch (repository.identity.platform) {
    case 'github':
      return { platform: 'github', fullName: repository.repoFullName };
    case 'gitlab': {
      const fullName =
        repoFullNameFromGitUrl(repository.identity.cloneUrl, repository.identity.cloneUrl) ??
        repository.repoFullName;
      return { platform: 'gitlab', fullName };
    }
    case 'bitbucket':
      return undefined;
  }
}

function byocOwner(reference: EnvironmentReference): ByocVercelOwner {
  return reference.owner.type === 'organization'
    ? { organizationId: reference.owner.id }
    : { userId: reference.owner.id };
}

function credentialInput(
  reference: EnvironmentReference,
  credentialId: string
): ByocVercelCredentialFetchInput {
  return { ...byocOwner(reference), credentialId };
}

function allowedByocOwner(
  env: Pick<Env, 'BYOC_VERCEL_IDS'>,
  reference: EnvironmentReference
): boolean {
  return (
    enrolledByocVercelOwner(
      env,
      reference.owner.type === 'organization'
        ? { orgId: reference.owner.id }
        : { userId: reference.owner.id }
    ) !== undefined
  );
}

/**
 * Resolve the saved environment, repository and context allocation once, then
 * validate the provider it names. A missing saved choice falls back to the
 * native builder exactly as before.
 */
export async function resolveEnvironmentBuildTarget(args: {
  env: Env;
  db: WorkerDb;
  reference: EnvironmentReference;
  repoFullName: string | undefined;
  commands: readonly string[];
  sandboxAllocation: string | null;
}): Promise<BuildTargetResolution> {
  const { env, reference } = args;
  const repository = selectionRepository(reference, args.repoFullName);
  if (repository === null) {
    return { ok: false, provider: null, reason: 'The build has no repository' };
  }
  const target = allocationTarget(repository);
  const allocation = await resolveSavedSandboxAllocation({
    db: args.db,
    env,
    owner: selectionOwner(reference),
    repositoryType: repository.identity.platform,
    environment: reference,
    ...(args.sandboxAllocation ? { environmentAllocation: args.sandboxAllocation } : {}),
    ...(target ? { target } : {}),
  });

  if (allocation !== undefined && getSandboxAllocationProvider(allocation) === 'vercel') {
    return resolveVercelTarget(env, reference, allocation);
  }

  if (!allowedNativeBuild(env)) {
    return {
      ok: false,
      provider: 'cloudflare-containers',
      reason: nativeUnsupportedReason(env),
    };
  }
  return {
    ok: true,
    target: { provider: 'cloudflare-containers', instance: builderInstance(args.commands) },
  };
}

async function resolveVercelTarget(
  env: Env,
  reference: EnvironmentReference,
  allocation: SandboxAllocation
): Promise<BuildTargetResolution> {
  if (!allowedByocOwner(env, reference)) {
    return { ok: false, provider: 'vercel', reason: 'Vercel BYOC is not enabled for this owner' };
  }
  try {
    // The credential row is the single source for the account identity and the
    // ready base snapshot. It is decrypted only in the operation that uses it.
    const enrollment =
      reference.owner.type === 'organization'
        ? await fetchByocVercelEnrollment(env, reference.owner.id)
        : await fetchByocVercelEnrollmentForUser(env, reference.owner.id);
    const credential = await fetchByocVercelCredential(
      env,
      credentialInput(reference, enrollment.credentialId)
    );
    if (
      credential.setupStatus !== 'ready' ||
      !credential.runtimeBuildId ||
      !credential.runtimeSnapshotId ||
      credential.buildGeneration !== enrollment.buildGeneration
    ) {
      return { ok: false, provider: 'vercel', reason: 'Vercel compute setup is not ready' };
    }
    const instance = vercelBuilderInstanceSchema.safeParse(allocation);
    if (!instance.success) {
      return {
        ok: false,
        provider: 'vercel',
        reason: 'The saved Vercel allocation is not supported',
      };
    }
    return {
      ok: true,
      target: {
        provider: 'vercel',
        credentialId: credential.credentialId,
        teamId: credential.teamId,
        projectId: credential.projectId,
        runtimeBuildId: credential.runtimeBuildId,
        baseSnapshotId: credential.runtimeSnapshotId,
        instance: instance.data,
      },
    };
  } catch (error) {
    // A missing credential is a definitive answer. Any other failure (the
    // resolver is unreachable, or its response is malformed) is transient, so
    // it must surface instead of claiming the provider is unsupported.
    if (error instanceof ByocCredentialMissingError) {
      return { ok: false, provider: 'vercel', reason: 'Vercel credentials are unavailable' };
    }
    throw error;
  }
}

function allowedNativeBuild(env: Env): boolean {
  return env.SANDBOX_CONTAINERS !== undefined && builderRuntimeUnsupportedReason(env) === null;
}

function nativeUnsupportedReason(env: Env): string {
  if (!env.SANDBOX_CONTAINERS) return 'Native containers are not configured';
  return builderRuntimeUnsupportedReason(env) ?? 'The saved sandbox allocation is not supported';
}

/** The base identity compatibility compares for a pinned target. */
export function targetBaseImage(
  target: EnvironmentBuildTarget,
  nativeImage: () => Promise<string | null>
): Promise<string | null> {
  return target.provider === 'vercel'
    ? Promise.resolve(vercelSnapshotBaseImage(target))
    : nativeImage();
}
