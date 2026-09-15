import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';

/** One child directory returned by `list_directories`. */
export type DirectoryEntry = { name: string; path: string };

/** The folder picker's view of the current listing. */
type ListDirectoriesState =
  | { phase: 'skeleton'; path: string }
  | { phase: 'ready'; path: string; directories: DirectoryEntry[] }
  | { phase: 'retryable'; path: string }
  | { phase: 'unsupported'; path: string };

export type UseListDirectoriesResult = {
  /** State of the most recently requested listing. */
  state: ListDirectoriesState | null;
  /**
   * List one level of `path` (`""` means the CLI launch directory). Serves a
   * previously listed path from cache synchronously; otherwise shows skeleton
   * and fetches. A repeated call for the path already on screen is the picker's
   * Retry: it refetches that query, which drops back to the skeleton until the
   * retry lands.
   */
  list: (path: string) => void;
};

/**
 * Marks the SDK outcomes that retrying can never fix (`unsupported`/`invalid`).
 * React Query owns the error state, so the marker is what keeps those outcomes
 * terminal instead of the picker's retryable branch.
 */
class DirectoryListingUnsupported extends Error {}

/**
 * One-level directory listing client for the folder picker.
 *
 * React Query owns the per-path cache, the in-flight dedupe and the error
 * state; the query key `['list-directories', connectionId, path]` replaces the
 * hand-rolled per-path cache and the generation counter whose only job was to
 * drop a result for a path the user had already left. `listDirectoriesOnConnection`
 * never throws, so the SDK remains the classifier and this hook only projects
 * its outcome onto the picker's phases:
 *
 *   - `skeleton` (the requested listing has no data yet)
 *   - `ready` (resolved listing, cached per key so Back has no network wait)
 *   - `retryable` (`transport`: retrying may succeed)
 *   - `unsupported` (`unsupported`/`invalid`: retrying would be pure waste)
 *
 * `staleTime: Infinity` is what the replaced cache did: a listed path is never
 * stale, so returning to it serves its data synchronously and never refetches.
 * `retry: false` keeps the picker's Retry CTA the only retry, matching the old
 * generation-guard flow. A `transport` failure is thrown as a plain `Error`, so
 * the app-wide `QueryCache.onError` telemetry reports it like any other failed
 * query; it carries no tRPC code, so no auth or permission handling changes.
 */
export function useListDirectories(connectionId: string | null): UseListDirectoriesResult {
  const connection = useUserWebConnection();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string | null>(null);

  const query = useQuery<DirectoryEntry[]>({
    queryKey: ['list-directories', connectionId, path],
    queryFn: async () => {
      // `enabled` guarantees both are set; the guard narrows the types and
      // keeps the queryFn total for the impossible case.
      if (connectionId === null || path === null) {
        throw new Error('directory listing requested without a connection');
      }
      const result = await listDirectoriesOnConnection(
        connection,
        connectionId,
        path === '' ? undefined : path
      );
      if (result.ok) {
        return result.directories;
      }
      if (result.reason === 'transport') {
        // Retryable: React Query owns the error state, and `retry: false` leaves
        // the retry to the picker's Retry CTA.
        throw new Error('directory listing unavailable');
      }
      // Permanent for this connection; the marker keeps the phase terminal.
      throw new DirectoryListingUnsupported('directory listing unsupported');
    },
    enabled: connectionId !== null && path !== null,
    staleTime: Infinity,
    retry: false,
  });

  // The replaced `cacheRef` lived exactly as long as the picker screen, so a
  // reopen listed the launch path again. The query cache is app-wide; drop this
  // connection's listings with the hook that asked for them. `removeQueries`
  // matches the `['list-directories', connectionId]` prefix, so every path
  // listed by this sheet goes too.
  useEffect(
    () => () => {
      queryClient.removeQueries({ queryKey: ['list-directories', connectionId] });
    },
    [queryClient, connectionId]
  );

  // Keep the latest query in a ref so `list` stays referentially stable: the
  // picker's mount effect depends on it and re-running that effect would
  // refetch the launch path.
  const queryRef = useRef(query);
  queryRef.current = query;
  // The path the picker last asked for. A repeat means the Retry CTA, not a
  // navigation, because Back and drilling always target a different path.
  const requestedPathRef = useRef<string | null>(null);

  const list = useCallback((nextPath: string) => {
    if (requestedPathRef.current === nextPath) {
      // A no-data refetch goes back to pending and clears the error
      // (`fetchState` in @tanstack/query-core), so the picker shows its
      // skeleton again before the retry lands — the phase the replaced
      // generation guard produced.
      void queryRef.current.refetch();
      return;
    }
    requestedPathRef.current = nextPath;
    setPath(nextPath);
  }, []);

  const state = useMemo<ListDirectoriesState | null>(() => {
    if (path === null) {
      // No `list` call yet: the picker renders its skeleton branch.
      return null;
    }
    if (query.isPending) {
      // Also covers `enabled: false` (no connection): the listing can never
      // arrive, so the picker stays on its skeleton.
      return { phase: 'skeleton', path };
    }
    if (query.isError) {
      return {
        phase: query.error instanceof DirectoryListingUnsupported ? 'unsupported' : 'retryable',
        path,
      };
    }
    return { phase: 'ready', path, directories: query.data };
  }, [path, query.data, query.error, query.isError, query.isPending]);

  return { state, list };
}
