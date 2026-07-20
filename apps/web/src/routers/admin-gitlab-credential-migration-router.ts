import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  acquireGitLabCredentialMigrationJobLease,
  cancelGitLabCredentialMigrationJob,
  createGitLabCredentialMigrationJob,
  failGitLabCredentialMigrationJob,
  getGitLabCredentialMigrationJob,
  GitLabCredentialMigrationJobConflictError,
  listRecentGitLabCredentialMigrationJobs,
  releaseGitLabCredentialMigrationJobLease,
  type GitLabCredentialMigrationJobRecord,
} from '@/lib/integrations/platforms/gitlab/credential-migration-job-repository';
import { advanceGitLabCredentialMigrationJob } from '@/lib/integrations/platforms/gitlab/credential-migration-job';

const StartInputSchema = z
  .object({
    mode: z.enum(['audit', 'backfill', 'scrub']),
    confirmation: z.string().optional(),
  })
  .strict();

function safeJob(job: GitLabCredentialMigrationJobRecord) {
  return {
    id: job.id,
    requestedMode: job.requested_mode,
    phase: job.phase,
    status: job.status,
    cursorPresent: job.cursor !== null,
    scannedIntegrations: job.scanned_integrations,
    mutatedIntegrations: job.mutated_integrations,
    publicAuditCounts: job.public_audit_counts,
    privateAuditCounts: job.private_audit_counts,
    issueIntegrationIds: job.issue_integration_ids,
    errorCode: job.error_code,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    cancellationNote:
      job.status === 'cancelled'
        ? 'Cancellation does not undo completed backfill or restore scrubbed plaintext.'
        : undefined,
  };
}

export const adminGitLabCredentialMigrationRouter = createTRPCRouter({
  startGitLabCredentialMigrationJob: adminProcedure
    .input(StartInputSchema)
    .mutation(async ({ ctx, input }) => {
      const requiredConfirmation =
        input.mode === 'backfill'
          ? 'BACKFILL GITLAB CREDENTIALS'
          : input.mode === 'scrub'
            ? 'SCRUB GITLAB PLAINTEXT'
            : undefined;
      if (requiredConfirmation && input.confirmation !== requiredConfirmation) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Exact migration confirmation is required',
        });
      }
      try {
        return safeJob(
          await createGitLabCredentialMigrationJob({
            mode: input.mode,
            requestedByUserId: ctx.user.id,
          })
        );
      } catch (error) {
        if (error instanceof GitLabCredentialMigrationJobConflictError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message });
        }
        throw error;
      }
    }),
  runGitLabCredentialMigrationJob: adminProcedure.mutation(async () => {
    const job = await acquireGitLabCredentialMigrationJobLease();
    if (!job) return { status: 'noop' as const, job: null };

    const leaseToken = job.lease_token;
    try {
      const step = await advanceGitLabCredentialMigrationJob(job);
      if (step.kind === 'advanced' || step.kind === 'retryable') {
        await releaseGitLabCredentialMigrationJobLease(job.id, leaseToken);
      }
      const updatedJob =
        step.kind === 'advanced' ? step.job : await getGitLabCredentialMigrationJob(job.id);
      return { status: step.kind, job: updatedJob ? safeJob(updatedJob) : null };
    } catch {
      await failGitLabCredentialMigrationJob(job.id, leaseToken, 'migration_runner_failed');
      const failedJob = await getGitLabCredentialMigrationJob(job.id);
      return { status: 'failed' as const, job: failedJob ? safeJob(failedJob) : null };
    }
  }),
  getGitLabCredentialMigrationJob: adminProcedure
    .input(z.object({ id: z.uuid() }).strict())
    .query(async ({ input }) => {
      const job = await getGitLabCredentialMigrationJob(input.id);
      if (!job) throw new TRPCError({ code: 'NOT_FOUND', message: 'Migration job not found' });
      return safeJob(job);
    }),
  listGitLabCredentialMigrationJobs: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict())
    .query(async ({ input }) => {
      return (await listRecentGitLabCredentialMigrationJobs(input.limit)).map(safeJob);
    }),
  cancelGitLabCredentialMigrationJob: adminProcedure
    .input(z.object({ id: z.uuid() }).strict())
    .mutation(async ({ input }) => {
      const job = await cancelGitLabCredentialMigrationJob(input.id);
      if (!job) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Migration job is not active or was not found',
        });
      }
      return safeJob(job);
    }),
});
