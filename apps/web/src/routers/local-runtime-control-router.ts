import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createAndRunLocalSessionRequestSchema,
  localRuntimeCreateOutputSchema,
  localRuntimeFenceSchema,
  type LocalRuntimeCreateOutput,
} from '@kilocode/session-ingest-contracts';

import { baseProcedure, createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import {
  LocalRuntimeControlClient,
  LocalRuntimeCatalogError,
  LocalRuntimeControlRequestError,
  LocalRuntimeCreateAndRunError,
  type LocalRuntimeCatalog,
  type LocalRuntimeList,
} from '@/lib/local-runtime-control/client';
import { waitForOwnedCliSession } from '@/lib/local-runtime-control/readiness';

const createAndRunInputSchema = z
  .object({
    fence: localRuntimeFenceSchema,
    request: createAndRunLocalSessionRequestSchema,
  })
  .strict();

export const localRuntimeControlRouter = createTRPCRouter({
  list: baseProcedure.query(async ({ ctx }): Promise<LocalRuntimeList> => {
    try {
      return await LocalRuntimeControlClient.list(ctx.user.id);
    } catch (err) {
      if (err instanceof LocalRuntimeControlRequestError) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'Local runtime control request failed',
        });
      }
      throw err;
    }
  }),

  getCatalog: baseProcedure
    .input(localRuntimeFenceSchema)
    .query(async ({ ctx, input }): Promise<LocalRuntimeCatalog> => {
      try {
        const response = await LocalRuntimeControlClient.getCatalog(ctx.user.id, input);
        return response.catalog;
      } catch (err) {
        if (err instanceof LocalRuntimeCatalogError) {
          throw new TRPCError({
            code: mapCatalogErrorCode(err.upstreamCode),
            message: err.message,
            cause: new UpstreamApiError(err.upstreamCode),
          });
        }
        throw err;
      }
    }),

  /**
   * Server-side create-and-run. The relay completes the runtime command and
   * returns the CLI's typed success/partial result; the server then waits for
   * the announced `cli_sessions_v2` row to become fetchable so the mobile
   * client can navigate directly to the existing session detail route.
   *
   * - `ready`  — owned row observed within the bounded wait. The CLI result
   *   is returned exactly as the relay produced it, including a
   *   `promptStarted:false` partial.
   * - `session_not_ready` — the server exhausted its bounded wait. The CLI
   *   result is still returned so mobile can open the existing session
   *   (for `promptStarted:false`) or poll the separate
   *   `cliSessionsV2.readiness` query for recovery. The server NEVER issues
   *   a second relay create command.
   *
   * Upstream failures from the relay collapse to a typed tRPC error with the
   * stable `LocalRuntimeControlErrorCode` attached as `cause: UpstreamApiError`
   * so mobile can branch on `err.data.upstreamCode`. The create call is
   * NEVER retried server-side.
   */
  createAndRun: baseProcedure
    .input(createAndRunInputSchema)
    .output(localRuntimeCreateOutputSchema)
    .mutation(async ({ ctx, input }): Promise<LocalRuntimeCreateOutput> => {
      const { fence, request } = input;
      let result;
      try {
        const response = await LocalRuntimeControlClient.createAndRun(ctx.user.id, fence, request);
        result = response.result;
      } catch (err) {
        if (err instanceof LocalRuntimeCreateAndRunError) {
          throw new TRPCError({
            code: mapCreateAndRunErrorCode(err.upstreamCode),
            message: err.message,
            cause: new UpstreamApiError(err.upstreamCode),
          });
        }
        if (err instanceof LocalRuntimeControlRequestError) {
          throw new TRPCError({
            code: 'BAD_GATEWAY',
            message: 'Local runtime create-and-run request failed',
          });
        }
        throw err;
      }

      // Wait for the owned row to become fetchable. The probe scopes to
      // (sessionId, kiloUserId) and re-validates current org membership when
      // the row carries an organizationId — a removed member surfaces here as
      // a FORBIDDEN rejection (mapped from the UNAUTHORIZED raised by
      // ensureOrganizationAccess so the contract is uniform across both
      // readiness surfaces), not a "ready" outcome.
      const ready = await waitForOwnedCliSession({
        sessionId: result.sessionId,
        userId: ctx.user.id,
        deps: {
          query: async (sessionId, kiloUserId) => {
            const { cli_sessions_v2 } = await import('@kilocode/db/schema');
            const { db } = await import('@/lib/drizzle');
            const { and, eq } = await import('drizzle-orm');
            const [row] = await db
              .select({ organizationId: cli_sessions_v2.organization_id })
              .from(cli_sessions_v2)
              .where(
                and(
                  eq(cli_sessions_v2.session_id, sessionId),
                  eq(cli_sessions_v2.kilo_user_id, kiloUserId)
                )
              )
              .limit(1);
            if (!row) return null;
            return { organizationId: row.organizationId ?? null };
          },
          ensureOrganizationAccess: async organizationId => {
            const { ensureOrganizationAccess } = await import(
              '@/routers/organizations/utils'
            );
            try {
              await ensureOrganizationAccess(ctx, organizationId);
            } catch (err) {
              if (err instanceof TRPCError && err.code === 'UNAUTHORIZED') {
                throw new TRPCError({
                  code: 'FORBIDDEN',
                  message: 'You no longer have access to this organization',
                  cause: err,
                });
              }
              throw err;
            }
          },
        },
      });

      if (ready === null) {
        return {
          status: 'session_not_ready',
          code: 'SESSION_NOT_READY',
          result,
        };
      }
      return { status: 'ready', result };
    }),
});

function mapCatalogErrorCode(upstreamCode: string): TRPCError['code'] {
  switch (upstreamCode) {
    case 'RUNTIME_NOT_CONNECTED':
      return 'NOT_FOUND';
    case 'RUNTIME_FENCE_MISMATCH':
    case 'CATALOG_CHANGED':
    case 'COMMAND_ALREADY_PENDING':
      return 'CONFLICT';
    case 'CLI_UPGRADE_REQUIRED':
      return 'PRECONDITION_FAILED';
    case 'COMMAND_EXPIRED':
      return 'TIMEOUT';
    case 'PENDING_COMMAND_LIMIT':
      return 'TOO_MANY_REQUESTS';
    case 'COMMAND_NOT_ALLOWED':
      return 'FORBIDDEN';
    case 'RESULT_TOO_LARGE':
    case 'INVALID_RUNTIME_RESPONSE':
    case 'RUNTIME_COMMAND_FAILED':
      return 'INTERNAL_SERVER_ERROR';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

function mapCreateAndRunErrorCode(upstreamCode: string): TRPCError['code'] {
  switch (upstreamCode) {
    case 'RUNTIME_NOT_CONNECTED':
      return 'NOT_FOUND';
    case 'RUNTIME_FENCE_MISMATCH':
    case 'CATALOG_CHANGED':
    case 'COMMAND_ALREADY_PENDING':
      return 'CONFLICT';
    case 'CLI_UPGRADE_REQUIRED':
      return 'PRECONDITION_FAILED';
    case 'COMMAND_EXPIRED':
      return 'TIMEOUT';
    case 'PENDING_COMMAND_LIMIT':
      return 'TOO_MANY_REQUESTS';
    case 'COMMAND_NOT_ALLOWED':
      return 'FORBIDDEN';
    case 'RESULT_TOO_LARGE':
    case 'INVALID_RUNTIME_RESPONSE':
    case 'RUNTIME_COMMAND_FAILED':
      return 'INTERNAL_SERVER_ERROR';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}
