import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';

import {
  organization_vercel_compute_credentials,
  type OrganizationVercelComputeCredential,
} from '@kilocode/db/schema';
import type { VercelComputeSetupStatus, VercelComputeSetupStep } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';
import {
  cleanupVercelSnapshotBuild,
  getVercelComputeEnrollment,
  getVercelComputeEnrollmentForUser,
  getVercelRuntimeIdentity,
  startVercelSnapshotBuild,
  type VercelSnapshotBuildStartInput,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import {
  discoverVercelProjects,
  discoverVercelTeams,
  validateVercelSelection,
  VercelApiError,
} from '@/lib/vercel-client';
import type { Owner } from '@/lib/integrations/core/types';
import {
  organizationAdminProcedure,
  OrganizationIdInputSchema,
} from '@/routers/organizations/utils';

const VercelIdentifierSchema = z.string().trim().min(1).max(256);
const VercelTokenSchema = z.string().trim().min(1).max(4096);

const OrganizationVercelComputeSetupInput = OrganizationIdInputSchema.extend({
  token: VercelTokenSchema,
  teamId: VercelIdentifierSchema,
  projectId: VercelIdentifierSchema,
});
const PersonalVercelComputeSetupInput = z.object({
  token: VercelTokenSchema,
  teamId: VercelIdentifierSchema,
  projectId: VercelIdentifierSchema,
});
const OrganizationVercelComputeDiscoveryInput = OrganizationIdInputSchema.extend({
  token: VercelTokenSchema,
});
const PersonalVercelComputeDiscoveryInput = z.object({ token: VercelTokenSchema });
const OrganizationVercelComputeProjectsInput = OrganizationIdInputSchema.extend({
  token: VercelTokenSchema,
  teamId: VercelIdentifierSchema,
});
const PersonalVercelComputeProjectsInput = z.object({
  token: VercelTokenSchema,
  teamId: VercelIdentifierSchema,
});
const VercelComputeRemoveInput = z.object({
  acknowledgeCleanupFailure: z.boolean().optional(),
});

const VercelComputeSetupStatusSchema = z.enum(['pending', 'building', 'ready', 'failed']);
const VercelComputeUpgradeStatusSchema = z.enum(['pending', 'building', 'failed']);

type VercelComputeStatusCommon = {
  credentialId: string;
  teamId: string;
  projectId: string;
  teamSlug: string | null;
  projectSlug: string | null;
  setupStatus: z.infer<typeof VercelComputeSetupStatusSchema>;
  setupStep: string | null;
  setupError: string | null;
  buildGeneration: string;
  runtimeBuildId: string | null;
  runtimeSnapshotId: string | null;
  runtimeWrapperVersion: string | null;
  runtimeReleasedAt: string | null;
  runtimeDigest: string | null;
  upgradeStatus: z.infer<typeof VercelComputeUpgradeStatusSchema> | null;
  upgradeStep: string | null;
  upgradeError: string | null;
  latestWrapperVersion: string | null;
  latestReleasedAt: string | null;
  latestDigest: string | null;
  upgradeAvailable: boolean;
  setupStartedAt: string | null;
  setupCompletedAt: string | null;
};

type VercelComputeStatus =
  | (VercelComputeStatusCommon & { organizationId: string })
  | (VercelComputeStatusCommon & { userId: string });

function ownerCondition(owner: Owner) {
  return owner.type === 'org'
    ? eq(organization_vercel_compute_credentials.organization_id, owner.id)
    : eq(organization_vercel_compute_credentials.user_id, owner.id);
}

async function findVercelComputeCredential(
  owner: Owner
): Promise<OrganizationVercelComputeCredential | undefined> {
  return await db.query.organization_vercel_compute_credentials.findFirst({
    where: ownerCondition(owner),
  });
}

function ownerSnapshotBuildInput(
  owner: Owner,
  credentialId: string,
  buildGeneration: string
): VercelSnapshotBuildStartInput {
  return {
    ...(owner.type === 'org' ? { organizationId: owner.id } : { userId: owner.id }),
    credentialId,
    buildGeneration,
  };
}

function ownerCredentialAad(owner: Owner, credentialId: string): string {
  return owner.type === 'org'
    ? `byoc-vercel-credential:v1:${owner.id}:${credentialId}`
    : `byoc-vercel-credential:v1:user:${owner.id}:${credentialId}`;
}

function statusFromRow(
  row: OrganizationVercelComputeCredential,
  owner: Owner
): VercelComputeStatus {
  const common = {
    credentialId: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    teamSlug: row.team_slug,
    projectSlug: row.project_slug,
    setupStatus: row.setup_status,
    setupStep: row.setup_step,
    setupError: row.setup_error,
    buildGeneration: row.build_generation,
    runtimeBuildId: row.runtime_build_id,
    runtimeSnapshotId: row.runtime_snapshot_id,
    runtimeWrapperVersion: row.runtime_wrapper_version,
    runtimeReleasedAt: row.runtime_released_at,
    runtimeDigest: row.runtime_digest,
    upgradeStatus: row.upgrade_status,
    upgradeStep: row.upgrade_step,
    upgradeError: row.upgrade_error,
    latestWrapperVersion: null,
    latestReleasedAt: null,
    latestDigest: null,
    upgradeAvailable: false,
    setupStartedAt: row.setup_started_at ? new Date(row.setup_started_at).toISOString() : null,
    setupCompletedAt: row.setup_completed_at
      ? new Date(row.setup_completed_at).toISOString()
      : null,
  } satisfies VercelComputeStatusCommon;

  if (owner.type === 'org') {
    if (row.organization_id === null) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Vercel compute credential is not organization-owned',
      });
    }
    return { ...common, organizationId: row.organization_id };
  }

  if (row.user_id === null) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Vercel compute credential is not user-owned',
    });
  }
  return { ...common, userId: row.user_id };
}

function runtimeBuildId(): string {
  return `vercel-runtime-${crypto.randomUUID()}`;
}

function newBuildGeneration(): string {
  return crypto.randomUUID();
}

function safeSetupFailure(error: unknown): { setupError: string } {
  if (error instanceof VercelSnapshotBuildStartError) {
    return { setupError: 'cloud_agent_unavailable' };
  }
  return { setupError: 'setup_start_failed' };
}

class VercelSnapshotBuildStartError extends Error {
  constructor() {
    super('Cloud Agent snapshot build could not be started');
    this.name = 'VercelSnapshotBuildStartError';
  }
}

async function startBuildOrMarkFailed(
  owner: Owner,
  credentialId: string,
  buildGeneration: string,
  mode: 'setup' | 'upgrade' = 'setup'
): Promise<void> {
  try {
    await startVercelSnapshotBuild(ownerSnapshotBuildInput(owner, credentialId, buildGeneration));
  } catch (error) {
    const { setupError } = safeSetupFailure(error);
    await db
      .update(organization_vercel_compute_credentials)
      .set(
        mode === 'upgrade'
          ? {
              upgrade_status: 'failed',
              upgrade_step: null,
              upgrade_error: setupError,
            }
          : {
              setup_status: 'failed',
              setup_step: null,
              setup_error: setupError,
            }
      )
      .where(
        and(
          ownerCondition(owner),
          eq(organization_vercel_compute_credentials.id, credentialId),
          eq(organization_vercel_compute_credentials.build_generation, buildGeneration)
        )
      );
    throw new VercelSnapshotBuildStartError();
  }
}

async function loadVercelComputeEnrollment(owner: Owner): Promise<boolean> {
  try {
    return owner.type === 'org'
      ? await getVercelComputeEnrollment(owner.id)
      : await getVercelComputeEnrollmentForUser(owner.id);
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Vercel compute enrollment could not be verified',
    });
  }
}

async function requireVercelComputeEnrollment(owner: Owner): Promise<void> {
  if (await loadVercelComputeEnrollment(owner)) return;

  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      owner.type === 'org'
        ? 'Customer-paid Vercel compute is not available for this organization'
        : 'Customer-paid Vercel compute is not available for this user',
  });
}

async function getCloudCardVisibility(owner: Owner): Promise<{ visible: boolean }> {
  // Existing credentials remain visible so an owner can disconnect after
  // enrollment is removed, without depending on the enrollment service.
  if (await findVercelComputeCredential(owner)) return { visible: true };
  return { visible: await loadVercelComputeEnrollment(owner) };
}

function rethrowVercelApiError(error: unknown): never {
  const failure =
    error instanceof VercelApiError ? error : new VercelApiError('SERVICE_UNAVAILABLE');
  throw new TRPCError({ code: failure.code, message: failure.message });
}

async function cleanupExistingVercelBuild(
  owner: Owner,
  credential: OrganizationVercelComputeCredential
): Promise<void> {
  if (owner.type === 'org' && credential.organization_id === null) return;
  if (owner.type === 'user' && credential.user_id !== owner.id) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Vercel compute credential owner is inconsistent',
    });
  }

  await cleanupVercelSnapshotBuild({
    ...ownerSnapshotBuildInput(owner, credential.id, credential.build_generation),
    ...(credential.runtime_snapshot_id ? { snapshotId: credential.runtime_snapshot_id } : {}),
  });
}

async function getStatusForOwner(owner: Owner): Promise<VercelComputeStatus | null> {
  const row = await findVercelComputeCredential(owner);
  if (!row) return null;

  const status = statusFromRow(row, owner);
  const latest = await getVercelRuntimeIdentity().catch(() => null);
  if (!latest) return status;
  return {
    ...status,
    latestWrapperVersion: latest.wrapperVersion,
    latestReleasedAt: latest.releasedAt,
    latestDigest: latest.digest,
    upgradeAvailable: row.setup_status === 'ready' && row.runtime_digest !== latest.digest,
  };
}

async function discoverTeamsForOwner(owner: Owner, token: string) {
  await requireVercelComputeEnrollment(owner);
  return await discoverVercelTeams(token).catch(rethrowVercelApiError);
}

async function discoverProjectsForOwner(owner: Owner, token: string, teamId: string) {
  await requireVercelComputeEnrollment(owner);
  return await discoverVercelProjects(token, teamId).catch(rethrowVercelApiError);
}

async function addForOwner(
  owner: Owner,
  input: { token: string; teamId: string; projectId: string }
): Promise<VercelComputeStatus> {
  await requireVercelComputeEnrollment(owner);

  const existing = await findVercelComputeCredential(owner);
  if (existing) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Vercel compute is already configured. Remove it before adding new credentials.',
    });
  }

  if (!AGENT_ENV_VARS_PUBLIC_KEY) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Vercel compute setup is not available',
    });
  }

  const selection = await validateVercelSelection(input.token, input.teamId, input.projectId).catch(
    rethrowVercelApiError
  );

  const credentialId = crypto.randomUUID();
  const buildGeneration = newBuildGeneration();
  const runtimeBuild = runtimeBuildId();
  const now = new Date().toISOString();
  const tokenEnvelopeScheme = 'byoc-vercel-credential-rsa-aes-256-gcm';
  const tokenEnvelopeKeyId = 'agent-env-vars-v1';
  const tokenEncrypted = parseKeyedEnvelope(
    encryptKeyedEnvelope(
      input.token,
      tokenEnvelopeScheme,
      {
        keyId: tokenEnvelopeKeyId,
        publicKeyPem: Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64'),
      },
      ownerCredentialAad(owner, credentialId)
    ),
    tokenEnvelopeScheme
  );

  let row: OrganizationVercelComputeCredential;
  try {
    [row] = await db
      .insert(organization_vercel_compute_credentials)
      .values({
        id: credentialId,
        organization_id: owner.type === 'org' ? owner.id : null,
        user_id: owner.type === 'user' ? owner.id : null,
        token_encrypted: tokenEncrypted,
        token_scope: selection.tokenScope,
        team_id: input.teamId,
        project_id: input.projectId,
        team_slug: selection.teamSlug,
        project_slug: selection.projectSlug,
        setup_status: 'pending',
        setup_step: 'validating_access',
        build_generation: buildGeneration,
        runtime_build_id: runtimeBuild,
        setup_started_at: now,
      })
      .returning();
  } catch {
    // Keep the unique owner constraint as the final race-safe guard.
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Vercel compute is already configured. Remove it before adding new credentials.',
    });
  }

  await startBuildOrMarkFailed(owner, row.id, buildGeneration);

  return statusFromRow(row, owner);
}

async function retrySetupForOwner(owner: Owner): Promise<VercelComputeStatus> {
  await requireVercelComputeEnrollment(owner);

  const current = await findVercelComputeCredential(owner);
  if (!current) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Vercel compute is not configured' });
  }

  try {
    await cleanupExistingVercelBuild(owner, current);
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Existing Vercel compute resources could not be cleaned up. Try again later.',
    });
  }

  const buildGeneration = newBuildGeneration();
  const runtimeBuild = runtimeBuildId();
  const now = new Date().toISOString();
  const [row] = await db
    .update(organization_vercel_compute_credentials)
    .set({
      setup_status: 'pending',
      setup_step: 'validating_access',
      setup_error: null,
      runtime_build_id: runtimeBuild,
      runtime_snapshot_id: null,
      build_generation: buildGeneration,
      setup_started_at: now,
      setup_completed_at: null,
      updated_at: now,
    })
    .where(
      and(
        ownerCondition(owner),
        eq(organization_vercel_compute_credentials.id, current.id),
        eq(organization_vercel_compute_credentials.build_generation, current.build_generation)
      )
    )
    .returning();

  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Vercel compute is not configured' });
  }

  await startBuildOrMarkFailed(owner, row.id, buildGeneration);

  return statusFromRow(row, owner);
}

async function upgradeRuntimeForOwner(owner: Owner): Promise<VercelComputeStatus> {
  await requireVercelComputeEnrollment(owner);

  const current = await findVercelComputeCredential(owner);
  if (!current) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Vercel compute is not configured' });
  }
  if (current.setup_status !== 'ready' || !current.runtime_snapshot_id) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Vercel compute must be ready before upgrading the runtime',
    });
  }
  if (current.upgrade_status === 'pending' || current.upgrade_status === 'building') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'A runtime upgrade is already in progress',
    });
  }

  const buildGeneration = newBuildGeneration();
  const runtimeBuild = runtimeBuildId();
  const now = new Date().toISOString();
  const [row] = await db
    .update(organization_vercel_compute_credentials)
    .set({
      build_generation: buildGeneration,
      runtime_build_id: runtimeBuild,
      upgrade_status: 'pending',
      upgrade_step: 'validating_access',
      upgrade_error: null,
      updated_at: now,
    })
    .where(
      and(
        ownerCondition(owner),
        eq(organization_vercel_compute_credentials.id, current.id),
        eq(organization_vercel_compute_credentials.build_generation, current.build_generation)
      )
    )
    .returning();

  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Vercel compute is not configured' });
  }

  await startBuildOrMarkFailed(owner, row.id, buildGeneration, 'upgrade');

  return statusFromRow(row, owner);
}

async function removeForOwner(
  owner: Owner,
  input: { acknowledgeCleanupFailure?: boolean }
): Promise<{ success: true }> {
  const current = await findVercelComputeCredential(owner);
  if (!current) return { success: true };

  try {
    await cleanupExistingVercelBuild(owner, current);
  } catch {
    if (!input.acknowledgeCleanupFailure) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Vercel resources could not be cleaned up. Review existing snapshots and sandboxes before removing credentials.',
      });
    }
  }

  const [removed] = await db
    .delete(organization_vercel_compute_credentials)
    .where(
      and(
        ownerCondition(owner),
        eq(organization_vercel_compute_credentials.id, current.id),
        eq(organization_vercel_compute_credentials.build_generation, current.build_generation)
      )
    )
    .returning({ id: organization_vercel_compute_credentials.id });

  if (!removed) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Vercel compute configuration changed. Refresh and try again.',
    });
  }

  return { success: true };
}

const organizationOwner = (organizationId: string): Owner => ({ type: 'org', id: organizationId });
const userOwner = (userId: string): Owner => ({ type: 'user', id: userId });

export const organizationVercelComputeRouter = createTRPCRouter({
  getEnrollment: organizationAdminProcedure.query(async ({ input }) => ({
    enrolled: await loadVercelComputeEnrollment(organizationOwner(input.organizationId)),
  })),

  getCloudCardVisibility: organizationAdminProcedure.query(async ({ input }) => {
    return await getCloudCardVisibility(organizationOwner(input.organizationId));
  }),

  getStatus: organizationAdminProcedure.query(async ({ input }) => {
    return await getStatusForOwner(organizationOwner(input.organizationId));
  }),

  discoverTeams: organizationAdminProcedure
    .input(OrganizationVercelComputeDiscoveryInput)
    .mutation(async ({ input }) => {
      return await discoverTeamsForOwner(organizationOwner(input.organizationId), input.token);
    }),

  discoverProjects: organizationAdminProcedure
    .input(OrganizationVercelComputeProjectsInput)
    .mutation(async ({ input }) => {
      return await discoverProjectsForOwner(
        organizationOwner(input.organizationId),
        input.token,
        input.teamId
      );
    }),

  add: organizationAdminProcedure
    .input(OrganizationVercelComputeSetupInput)
    .mutation(async ({ input }) => {
      return await addForOwner(organizationOwner(input.organizationId), input);
    }),

  retrySetup: organizationAdminProcedure.mutation(async ({ input }) => {
    return await retrySetupForOwner(organizationOwner(input.organizationId));
  }),

  upgradeRuntime: organizationAdminProcedure.mutation(async ({ input }) => {
    return await upgradeRuntimeForOwner(organizationOwner(input.organizationId));
  }),

  remove: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend(VercelComputeRemoveInput.shape))
    .mutation(async ({ input }) => {
      return await removeForOwner(organizationOwner(input.organizationId), input);
    }),
});

export const personalVercelComputeRouter = createTRPCRouter({
  getEnrollment: baseProcedure.query(async ({ ctx }) => ({
    enrolled: await loadVercelComputeEnrollment(userOwner(ctx.user.id)),
  })),

  getCloudCardVisibility: baseProcedure.query(async ({ ctx }) => {
    return await getCloudCardVisibility(userOwner(ctx.user.id));
  }),

  getStatus: baseProcedure.query(async ({ ctx }) => {
    return await getStatusForOwner(userOwner(ctx.user.id));
  }),

  discoverTeams: baseProcedure
    .input(PersonalVercelComputeDiscoveryInput)
    .mutation(async ({ ctx, input }) => {
      return await discoverTeamsForOwner(userOwner(ctx.user.id), input.token);
    }),

  discoverProjects: baseProcedure
    .input(PersonalVercelComputeProjectsInput)
    .mutation(async ({ ctx, input }) => {
      return await discoverProjectsForOwner(userOwner(ctx.user.id), input.token, input.teamId);
    }),

  add: baseProcedure.input(PersonalVercelComputeSetupInput).mutation(async ({ ctx, input }) => {
    return await addForOwner(userOwner(ctx.user.id), input);
  }),

  retrySetup: baseProcedure.mutation(async ({ ctx }) => {
    return await retrySetupForOwner(userOwner(ctx.user.id));
  }),

  upgradeRuntime: baseProcedure.mutation(async ({ ctx }) => {
    return await upgradeRuntimeForOwner(userOwner(ctx.user.id));
  }),

  remove: baseProcedure
    .input(VercelComputeRemoveInput.optional())
    .mutation(async ({ ctx, input }) => {
      return await removeForOwner(userOwner(ctx.user.id), input ?? {});
    }),
});

export type { VercelComputeSetupStatus, VercelComputeSetupStep };
