import { MutationCache, type Query, QueryCache, QueryClient } from '@tanstack/react-query';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';

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

/** The serialized tRPC error data, from either the direct or shaped variant. */
function trpcErrorData(error: unknown): TrpcErrorData | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const direct = (error as { data?: unknown }).data;
  if (typeof direct === 'object' && direct !== null) {
    return direct as TrpcErrorData;
  }
  const shaped = (error as { shape?: { data?: unknown } }).shape?.data;
  if (typeof shaped === 'object' && shaped !== null) {
    return shaped as TrpcErrorData;
  }
  return undefined;
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

/** The `input` field of a tRPC query key's meta segment, or undefined. */
function queryKeyInput(queryKey: unknown): unknown {
  if (!Array.isArray(queryKey) || queryKey.length < 2) {
    return undefined;
  }
  const meta = queryKey[1];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  return (meta as { input?: unknown }).input;
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
  const organizationId = (input as { organizationId?: unknown } | undefined)?.organizationId;
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
        removePermissionDeniedQueries(queryClient, error, query);
      },
    }),
    mutationCache: new MutationCache({
      onError: error => {
        void handleTrpcQueryError(error);
      },
    }),
  });
  return queryClient;
}

export const queryClient = createKiloAppQueryClient();
