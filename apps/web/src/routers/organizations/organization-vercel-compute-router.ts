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
  startVercelSnapshotBuild,
  type VercelSnapshotBuildStartInput,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  discoverVercelProjects,
  discoverVercelTeams,
  validateVercelSelection,
  VercelApiError,
} from '@/lib/vercel-client';
import {
  organizationAdminProcedure,
  OrganizationIdInputSchema,
} from '@/routers/organizations/utils';

const VercelIdentifierSchema = z.string().trim().min(1).max(256);
const VercelTokenSchema = z.string().trim().min(1).max(4096);

const VercelComputeSetupStatusSchema = z.enum(['pending', 'building', 'ready', 'failed']);

const VercelComputeStatusOutput = z.object({
  credentialId: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.string(),
  projectId: z.string(),
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
  setupStatus: VercelComputeSetupStatusSchema,
  setupStep: z.string().nullable(),
  setupError: z.string().nullable(),
  buildGeneration: z.uuid(),
  runtimeBuildId: z.string().nullable(),
  runtimeSnapshotId: z.string().nullable(),
  setupStartedAt: z.string().nullable(),
  setupCompletedAt: z.string().nullable(),
});

type VercelComputeStatus = z.infer<typeof VercelComputeStatusOutput>;

function statusFromRow(row: OrganizationVercelComputeCredential): VercelComputeStatus {
  return {
    credentialId: row.id,
    organizationId: row.organization_id,
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
    setupStartedAt: row.setup_started_at ? new Date(row.setup_started_at).toISOString() : null,
    setupCompletedAt: row.setup_completed_at
      ? new Date(row.setup_completed_at).toISOString()
      : null,
  };
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
  input: VercelSnapshotBuildStartInput,
  credentialId: string,
  buildGeneration: string
): Promise<void> {
  try {
    await startVercelSnapshotBuild(input);
  } catch (error) {
    const { setupError } = safeSetupFailure(error);
    await db
      .update(organization_vercel_compute_credentials)
      .set({
        setup_status: 'failed',
        setup_step: null,
        setup_error: setupError,
      })
      .where(
        and(
          eq(organization_vercel_compute_credentials.id, credentialId),
          eq(organization_vercel_compute_credentials.build_generation, buildGeneration)
        )
      );
    throw new VercelSnapshotBuildStartError();
  }
}

async function loadVercelComputeEnrollment(organizationId: string): Promise<boolean> {
  try {
    return await getVercelComputeEnrollment(organizationId);
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Vercel compute enrollment could not be verified',
    });
  }
}

async function requireVercelComputeEnrollment(organizationId: string): Promise<void> {
  if (!(await loadVercelComputeEnrollment(organizationId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Customer-paid Vercel compute is not available for this organization',
    });
  }
}

function rethrowVercelApiError(error: unknown): never {
  const failure =
    error instanceof VercelApiError ? error : new VercelApiError('SERVICE_UNAVAILABLE');
  throw new TRPCError({ code: failure.code, message: failure.message });
}

async function cleanupExistingVercelBuild(
  credential: OrganizationVercelComputeCredential
): Promise<void> {
  await cleanupVercelSnapshotBuild({
    organizationId: credential.organization_id,
    credentialId: credential.id,
    buildGeneration: credential.build_generation,
    ...(credential.runtime_snapshot_id ? { snapshotId: credential.runtime_snapshot_id } : {}),
  });
}

export const organizationVercelComputeRouter = createTRPCRouter({
  getEnrollment: organizationAdminProcedure.query(async ({ input }) => ({
    enrolled: await loadVercelComputeEnrollment(input.organizationId),
  })),

  getStatus: organizationAdminProcedure.query(async ({ input }) => {
    const row = await db.query.organization_vercel_compute_credentials.findFirst({
      where: eq(organization_vercel_compute_credentials.organization_id, input.organizationId),
    });
    return row ? statusFromRow(row) : null;
  }),

  discoverTeams: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend({ token: VercelTokenSchema }))
    .mutation(async ({ input }) => {
      await requireVercelComputeEnrollment(input.organizationId);
      return discoverVercelTeams(input.token).catch(rethrowVercelApiError);
    }),

  discoverProjects: organizationAdminProcedure
    .input(
      OrganizationIdInputSchema.extend({
        token: VercelTokenSchema,
        teamId: VercelIdentifierSchema,
      })
    )
    .mutation(async ({ input }) => {
      await requireVercelComputeEnrollment(input.organizationId);
      return discoverVercelProjects(input.token, input.teamId).catch(rethrowVercelApiError);
    }),

  add: organizationAdminProcedure
    .input(
      OrganizationIdInputSchema.extend({
        token: VercelTokenSchema,
        teamId: VercelIdentifierSchema,
        projectId: VercelIdentifierSchema,
      })
    )
    .mutation(async ({ input }) => {
      await requireVercelComputeEnrollment(input.organizationId);

      const existing = await db.query.organization_vercel_compute_credentials.findFirst({
        where: eq(organization_vercel_compute_credentials.organization_id, input.organizationId),
      });
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

      await validateVercelSelection(input.token, input.teamId, input.projectId).catch(
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
          `byoc-vercel-credential:v1:${input.organizationId}:${credentialId}`
        ),
        tokenEnvelopeScheme
      );

      let row: OrganizationVercelComputeCredential;
      try {
        [row] = await db
          .insert(organization_vercel_compute_credentials)
          .values({
            id: credentialId,
            organization_id: input.organizationId,
            token_encrypted: tokenEncrypted,
            team_id: input.teamId,
            project_id: input.projectId,
            setup_status: 'pending',
            setup_step: 'validating_access',
            build_generation: buildGeneration,
            runtime_build_id: runtimeBuild,
            setup_started_at: now,
          })
          .returning();
      } catch {
        // Keep the unique organization constraint as the final race-safe guard.
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Vercel compute is already configured. Remove it before adding new credentials.',
        });
      }

      await startBuildOrMarkFailed(
        {
          organizationId: input.organizationId,
          credentialId,
          buildGeneration,
        },
        credentialId,
        buildGeneration
      );

      return statusFromRow(row);
    }),

  retrySetup: organizationAdminProcedure.mutation(async ({ input }) => {
    await requireVercelComputeEnrollment(input.organizationId);

    const current = await db.query.organization_vercel_compute_credentials.findFirst({
      where: eq(organization_vercel_compute_credentials.organization_id, input.organizationId),
    });
    if (!current) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Vercel compute is not configured' });
    }

    try {
      await cleanupExistingVercelBuild(current);
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
        team_slug: null,
        project_slug: null,
        runtime_build_id: runtimeBuild,
        runtime_snapshot_id: null,
        build_generation: buildGeneration,
        setup_started_at: now,
        setup_completed_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(organization_vercel_compute_credentials.id, current.id),
          eq(organization_vercel_compute_credentials.build_generation, current.build_generation)
        )
      )
      .returning();

    if (!row) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Vercel compute is not configured' });
    }

    await startBuildOrMarkFailed(
      {
        organizationId: input.organizationId,
        credentialId: row.id,
        buildGeneration,
      },
      row.id,
      buildGeneration
    );

    return statusFromRow(row);
  }),

  remove: organizationAdminProcedure
    .input(
      OrganizationIdInputSchema.extend({
        acknowledgeCleanupFailure: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const current = await db.query.organization_vercel_compute_credentials.findFirst({
        where: eq(organization_vercel_compute_credentials.organization_id, input.organizationId),
      });
      if (!current) return { success: true } as const;

      try {
        await cleanupExistingVercelBuild(current);
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

      return { success: true } as const;
    }),
});

export type { VercelComputeSetupStatus, VercelComputeSetupStep };
