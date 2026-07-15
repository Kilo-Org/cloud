import 'server-only';

import { TRPCError } from '@trpc/server';
import { localRuntimeFenceSchema } from '@kilocode/session-ingest-contracts';

import { baseProcedure, createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import {
  LocalRuntimeControlClient,
  LocalRuntimeCatalogError,
  LocalRuntimeControlRequestError,
  type LocalRuntimeCatalog,
  type LocalRuntimeList,
} from '@/lib/local-runtime-control/client';

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
