import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  backfillGitLabCredentialBatch,
  scrubGitLabCredentialBatch,
} from '@/lib/integrations/platforms/gitlab/credential-migration';
import {
  checkGitLabCredentialKeysMatch,
  verifyGitLabCredentialDecryptabilityBatch,
} from '@/lib/integrations/platforms/gitlab/credential-migration-verify';

const SCRUB_CONFIRMATION = 'SCRUB GITLAB PLAINTEXT';

const BatchInputSchema = z
  .object({
    afterId: z.uuid().nullable().default(null),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

/**
 * Stateless GitLab credential migration. There is no job table: each procedure
 * processes one keyset page and returns `nextCursor`; the caller walks the table
 * by passing it back until it is null. State lives in the data — a migrated row
 * simply stops matching the selection query.
 *
 * Operator flow: run your own SQL to audit → backfillNextBatch until done →
 * verifyDecryptability across all pages until it passes → scrubNextBatch until
 * done → re-run the audit SQL to confirm no plaintext remains.
 */
export const adminGitLabCredentialMigrationRouter = createTRPCRouter({
  backfillNextBatch: adminProcedure.input(BatchInputSchema).mutation(async ({ input }) => {
    return backfillGitLabCredentialBatch({ limit: input.limit, afterId: input.afterId });
  }),

  verifyDecryptability: adminProcedure
    .input(z.object({ cursor: z.string().nullable().default(null) }).strict())
    .mutation(async ({ ctx, input }) => {
      const result = await verifyGitLabCredentialDecryptabilityBatch({
        requestedByUserId: ctx.user.id,
        cursor: input.cursor,
      });
      if (result.kind === 'error') {
        throw new TRPCError({
          code: result.retryable ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
          message: `GitLab credential decryptability verification failed: ${result.errorCode}`,
        });
      }
      return result.batch;
    }),

  scrubNextBatch: adminProcedure
    .input(BatchInputSchema.extend({ confirmation: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      if (input.confirmation !== SCRUB_CONFIRMATION) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Exact scrub confirmation is required',
        });
      }
      // Guard the catastrophic keypair-mismatch case on every call. Full decrypt
      // coverage is the operator's responsibility via verifyDecryptability first.
      const keyMatch = await checkGitLabCredentialKeysMatch(ctx.user.id);
      if (!keyMatch.ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Refusing to scrub GitLab plaintext: ${keyMatch.errorCode}`,
        });
      }
      return scrubGitLabCredentialBatch({ limit: input.limit, afterId: input.afterId });
    }),
});
