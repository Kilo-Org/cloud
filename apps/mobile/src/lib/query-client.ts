import { MutationCache, type Query, QueryCache, QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';
import { reportTrpcError } from '@/lib/force-update-signal';

// tRPC error codes that retrying can never fix — surface these immediately
// instead of sitting on a skeleton through the default retry backoff.
const PERMANENT_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
]);

type TrpcErrorData = {
  code?: string;
  authRequired?: boolean;
};

const trpcErrorDataSchema = z.object({
  code: z.string().optional(),
  authRequired: z.boolean().optional(),
});
const trpcErrorShapeSchema = z.object({
  data: z.unknown().optional(),
  shape: z.object({ data: z.unknown().optional() }).optional(),
});

/** The serialized tRPC error data, from either the direct or shaped variant. */
function trpcErrorData(error: unknown): TrpcErrorData | undefined {
  const parsedError = trpcErrorShapeSchema.safeParse(error);
  if (!parsedError.success) {
    return undefined;
  }
  const direct = trpcErrorDataSchema.safeParse(parsedError.data.data);
  if (direct.success) {
    return direct.data;
  }
  const shaped = trpcErrorDataSchema.safeParse(parsedError.data.shape?.data);
  return shaped.success ? shaped.data : undefined;
}

/**
 * True when the error is a permission loss: a `FORBIDDEN`, or a procedure-level
 * `UNAUTHORIZED` without the context-level `authRequired` flag (which the
 * unauthorized handler signs the user out on). Permission loss must drop the
 * affected cache, not the session.
 */
function isPermissionDeniedError(error: unknown): boolean {
  const data = trpcErrorData(error);
  if (data?.code === 'FORBIDDEN') {
    return true;
  }
  return data?.code === 'UNAUTHORIZED' && data.authRequired !== true;
}

type QueryKeyInput = { organizationId?: unknown };

const queryKeyMetaSchema = z.object({ input: z.unknown().optional() });

/** The `input` field of a tRPC query key's meta segment, or undefined. */
function queryKeyInput(queryKey: unknown): QueryKeyInput | undefined {
  if (!Array.isArray(queryKey) || queryKey.length < 2) {
    return undefined;
  }
  const parsedMeta = queryKeyMetaSchema.safeParse(queryKey[1]);
  return parsedMeta.success ? (parsedMeta.data.input as QueryKeyInput | undefined) : undefined;
}

/**
 * Drops a permission-denied query from the cache so the next persister save
 * omits it. An org-scoped query is removed by its org prefix (procedure path +
 * `input.organizationId`), which also covers every sibling variant of that
 * procedure for the same org; a non-org query is removed by its exact key.
 */
function removePermissionDeniedQueries(
  queryClient: QueryClient,
  error: unknown,
  query: Query<unknown, unknown, unknown>
): void {
  if (!isPermissionDeniedError(error)) {
    return;
  }
  const input = queryKeyInput(query.queryKey);
  const organizationId = input?.organizationId;
  if (organizationId !== undefined && organizationId !== null) {
    queryClient.removeQueries({
      queryKey: [query.queryKey[0], { input: { organizationId } }],
    });
    return;
  }
  queryClient.removeQueries({ queryKey: query.queryKey });
}

export function createKiloAppQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          const code = (error as { data?: { code?: string } } | null)?.data?.code;
          if (code !== undefined && PERMANENT_CODES.has(code)) {
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 3000),
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        void handleTrpcQueryError(error);
        reportTrpcError(error);
        // Removing a still-observed query rebuilds it on the next render and
        // refetches, which fails FORBIDDEN again and loops for as long as the
        // error screen stays mounted. Only drop queries nothing is observing.
        if (!query.isActive()) {
          removePermissionDeniedQueries(queryClient, error, query);
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: error => {
        void handleTrpcQueryError(error);
        reportTrpcError(error);
      },
    }),
  });
  return queryClient;
}

export const queryClient = createKiloAppQueryClient();
