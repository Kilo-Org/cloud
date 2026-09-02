import {
  CancelledError,
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
  type QueryFunction,
  type QueryKey,
} from '@tanstack/react-query';
import { z } from 'zod';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';
import { reportTrpcError } from '@/lib/force-update-signal';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

export type ActiveSessionsQueryMetadata = Readonly<{
  acceptedRevision: number;
  terminalError: Readonly<{
    error: unknown;
    kind: 'retryable' | 'non-retryable';
  }> | null;
}>;

// Old/manual-only cache entries have no server provenance. They cannot establish
// empty success; keep this fallback while those entries can occur.
const EMPTY_ACTIVE_SESSIONS_METADATA: ActiveSessionsQueryMetadata = {
  acceptedRevision: 0,
  terminalError: null,
};
const activeSessionsMetadata = new WeakMap<Query, ActiveSessionsQueryMetadata>();
const activeSessionsListeners = new WeakMap<Query, Set<() => void>>();
const activeSessionsQueryKeySchema = z.tuple([
  z.tuple([z.literal('activeSessions'), z.literal('list')]),
  z.object({ type: z.literal('query'), input: z.unknown().optional() }),
]);

export function getActiveSessionsQueryMetadata(
  query: Query | undefined
): ActiveSessionsQueryMetadata {
  return (query && activeSessionsMetadata.get(query)) ?? EMPTY_ACTIVE_SESSIONS_METADATA;
}

export function subscribeActiveSessionsQueryMetadata(
  query: Query | undefined,
  listener: () => void
): () => void {
  if (!query) {
    return () => undefined;
  }
  const listeners = activeSessionsListeners.get(query) ?? new Set<() => void>();
  activeSessionsListeners.set(query, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function captureActiveSessionsQueryRefresh(client: QueryClient, queryKey: QueryKey) {
  const query = client.getQueryCache().build(client, { queryKey });
  const revision = getActiveSessionsQueryMetadata(query).acceptedRevision;
  const isCurrent = () => client.getQueryCache().get(query.queryHash) === query;
  return {
    isCurrent,
    hasAcceptedResult: () =>
      isCurrent() && getActiveSessionsQueryMetadata(query).acceptedRevision > revision,
  };
}

/** Keep canceled account/attachment work out of Query's success reducer. */
export function fenceActiveSessionsQuery<TData, TKey extends QueryKey>(
  queryFn: QueryFunction<TData, TKey>,
  isCurrent: () => boolean
): QueryFunction<TData, TKey> {
  return async context => {
    if (!isCurrent()) {
      throw new CancelledError({ revert: true });
    }
    const result = await queryFn(context);
    if (!isCurrent()) {
      throw new CancelledError({ revert: true });
    }
    return result;
  };
}

function observeActiveSessionsQueryOutcomes(queryCache: QueryCache): void {
  // This client-lifetime subscription survives QueryClient.clear().
  queryCache.subscribe(event => {
    const query: Query = event.query;
    if (!activeSessionsQueryKeySchema.safeParse(query.queryKey).success) {
      return;
    }
    const previous = getActiveSessionsQueryMetadata(query);
    if (event.type === 'removed') {
      activeSessionsMetadata.delete(query);
    } else if (
      event.type === 'updated' &&
      event.action.type === 'success' &&
      !event.action.manual
    ) {
      activeSessionsMetadata.set(query, {
        acceptedRevision: previous.acceptedRevision + 1,
        terminalError: null,
      });
    } else if (
      event.type === 'updated' &&
      event.action.type === 'error' &&
      !(event.action.error instanceof CancelledError)
    ) {
      if (previous.terminalError?.error === event.action.error) {
        return;
      }
      activeSessionsMetadata.set(query, {
        ...previous,
        terminalError: {
          error: event.action.error,
          kind: isTerminalTrpcCode(readTrpcErrorField(event.action.error, 'code'))
            ? 'non-retryable'
            : 'retryable',
        },
      });
    } else {
      return;
    }
    for (const listener of activeSessionsListeners.get(query) ?? []) {
      listener();
    }
  });
}

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
        // Foreground freshness is owned per route by useRouteForegroundRefresh mounts; the blanket focusManager refetch also woke frozen background tabs.
        refetchOnWindowFocus: false,
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
  observeActiveSessionsQueryOutcomes(queryClient.getQueryCache());
  return queryClient;
}

export const queryClient = createKiloAppQueryClient();
