import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { readEnvironmentReference, type EnvironmentReference } from '@kilocode/cloud-agent-profile';
import { validateBalanceOnly } from '../../balance-validation.js';
import { getPgDb } from '../../db/pg.js';
import { environmentActorAccess } from '../../environment-build/access.js';
import {
  environmentBuildCancelResultSchema,
  environmentBuildLogsSchema,
  environmentBuildRequestResultSchema,
  environmentBuildStatusSchema,
  type EnvironmentBuildRequestResult,
} from '../../shared/environment-build-status.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { TRPCContext } from '../../types.js';
import { protectedProcedure } from '../auth.js';

/**
 * Environment build operations (plan "Build admission and execution"). Every
 * handler authorizes before it reaches the coordinator: the environment must
 * exist under the caller's owner, Build, Refresh, Cancel and logs need the
 * environment management role, and status needs read access. The web router
 * checks the same roles; this is the authoritative boundary.
 */

const environmentScopeSchema = z
  .object({
    environmentId: z.string().uuid(),
    kilocodeOrganizationId: z.string().uuid().optional(),
  })
  .strict();

type Scope = z.infer<typeof environmentScopeSchema>;
type Access = 'manage' | 'read';

async function authorize(
  ctx: TRPCContext,
  scope: Scope,
  required: Access
): Promise<EnvironmentReference> {
  const db = getPgDb(ctx.env);
  const owner: EnvironmentReference['owner'] = scope.kilocodeOrganizationId
    ? { type: 'organization', id: scope.kilocodeOrganizationId }
    : { type: 'user', id: ctx.userId };
  const reference = await readEnvironmentReference(db, scope.environmentId);
  if (
    reference === null ||
    reference.owner.type !== owner.type ||
    reference.owner.id !== owner.id
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }
  const access = await environmentActorAccess(db, owner, ctx.userId);
  if (access === 'none') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }
  if (required === 'manage' && access !== 'manage') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Managing environment builds requires an organization owner or admin',
    });
  }
  return reference;
}

function coordinator(ctx: TRPCContext, environmentId: string) {
  return () => ctx.env.ENVIRONMENT_BUILD.getByName(environmentId);
}

export const buildEnvironment = protectedProcedure
  .input(
    environmentScopeSchema.extend({
      expectedRevision: z.number().int().positive(),
      /** Client-generated; a retried request after a lost response reuses it. */
      requestId: z.string().uuid(),
    })
  )
  .output(environmentBuildRequestResultSchema)
  .mutation(async ({ input, ctx }) => {
    const reference = await authorize(ctx, input, 'manage');
    // A manual build fails fast with a specific, recoverable billing reason.
    const balance = await validateBalanceOnly(ctx.authToken, input.kilocodeOrganizationId, ctx.env);
    if (!balance.success && balance.status === 402) {
      return { status: 'rejected' as const, reason: 'billing_blocked' as const };
    }
    return withDORetry(
      coordinator(ctx, input.environmentId),
      async (stub): Promise<EnvironmentBuildRequestResult> =>
        stub.requestBuild({
          environmentId: input.environmentId,
          owner: reference.owner,
          expectedRevision: input.expectedRevision,
          requestId: input.requestId,
          trigger: 'manual',
          actorUserId: ctx.userId,
        }),
      'environmentBuild.request'
    );
  });

export const getEnvironmentBuildStatus = protectedProcedure
  .input(environmentScopeSchema)
  .output(environmentBuildStatusSchema)
  .query(async ({ input, ctx }) => {
    const reference = await authorize(ctx, input, 'read');
    return withDORetry(
      coordinator(ctx, input.environmentId),
      stub =>
        stub.status({
          environmentId: input.environmentId,
          owner: reference.owner,
          configurationRevision: reference.configurationRevision,
        }),
      'environmentBuild.status'
    );
  });

export const getEnvironmentBuildLogs = protectedProcedure
  .input(
    environmentScopeSchema.extend({
      buildId: z.string().uuid(),
      cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(1000).default(500),
    })
  )
  .output(environmentBuildLogsSchema)
  .query(async ({ input, ctx }) => {
    await authorize(ctx, input, 'manage');
    const logs = await withDORetry(
      coordinator(ctx, input.environmentId),
      stub =>
        stub.logs({
          environmentId: input.environmentId,
          buildId: input.buildId,
          cursor: input.cursor,
          limit: input.limit,
        }),
      'environmentBuild.logs'
    );
    if (logs === null) throw new TRPCError({ code: 'NOT_FOUND', message: 'Build not found' });
    return logs;
  });

export const cancelEnvironmentBuild = protectedProcedure
  .input(environmentScopeSchema.extend({ buildId: z.string().uuid() }))
  .output(environmentBuildCancelResultSchema)
  .mutation(async ({ input, ctx }) => {
    await authorize(ctx, input, 'manage');
    return withDORetry(
      coordinator(ctx, input.environmentId),
      stub => stub.cancel({ environmentId: input.environmentId, buildId: input.buildId }),
      'environmentBuild.cancel'
    );
  });

/**
 * Prompt cleanup after an environment was deleted. The coordinator acts only
 * when PostgreSQL no longer has the environment, so the call grants nothing;
 * correctness never depends on it arriving.
 */
export const notifyEnvironmentDeleted = protectedProcedure
  .input(z.object({ environmentId: z.string().uuid() }).strict())
  .output(z.object({ ok: z.literal(true) }))
  .mutation(async ({ input, ctx }) => {
    await withDORetry(
      coordinator(ctx, input.environmentId),
      stub => stub.environmentDeleted({ environmentId: input.environmentId }),
      'environmentBuild.deleted'
    );
    return { ok: true as const };
  });
