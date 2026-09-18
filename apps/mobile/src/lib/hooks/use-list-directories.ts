import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { withDeadline } from '@kilocode/event-service';
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
   * retry lands. A repeat while that listing still has no data and a fetch is in
   * flight is dropped — query-core reuses the in-flight fetch, so a second
   * attempt cannot start and the Retry budget must stay unarmed.
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
 * Budget for one directory listing before the picker offers Retry. The SDK's
 * command path waits up to `COMMAND_TIMEOUT_MS` (30 s) for the user-web socket
 * to become usable, so a transport that fails without a close event — a
 * stalled relay, a device whose network is gone before the socket opens —
 * kept the sheet on its skeleton far past the picker's error budget: the
 * mobile-app e8 scenario asserted the retryable state after 15 s and saw only
 * skeleton rows (2026-09-16). Every attempt gets the same budget, so the
 * picker's loading state stays the sheet's loading state whatever the
 * transport does; a listing that has not answered in this budget is reported
 * as the same `transport` failure the SDK reports for a broken socket, and the
 * picker shows "Couldn't list folders" with Retry.
 *
 * The budget also has to leave the loading state observable — a hung transport
 * holds the skeleton for exactly this long, and the sheet's loading rows are
 * part of the picker's contract — while every attempt still reports its
 * failure inside the scenario's 15 s window.
 */
const LISTING_DEADLINE_MS = 12_000;

/**
 * Budget and pacing for the picker's own Retry CTA (a repeat `list` call for
 * the path already on screen). A Retry has to bridge the lags a relay restart
 * leaves behind, which the sheet's first open does not wait for:
 *
 *  - The app's user-web socket rebuilds within a couple of seconds once the
 *    relay answers again.
 *  - The CLI re-attaches to a restarted relay on its own reconnect loop, whose
 *    backoff caps at 30 s ± jitter — measured at ~38 s after the relay came
 *    back (2026-09-17). Until then the relay answers every send with a fast
 *    retryable failure, so a Retry that gives up on one send reports the same
 *    error the sheet already shows and the user has to tap again for every
 *    step of the recovery.
 *
 * A Retry therefore keeps sending — paced, so a CLI-less relay is asked again
 * rather than abandoned after one fast failure — until either the listing
 * lands or this budget expires and the sheet reports the retryable error
 * again. The picker shows its skeleton while it waits; the initial open keeps
 * its single send and its 12 s budget, so the retryable state still appears
 * inside the sheet's 15 s window.
 */
const LISTING_RETRY_DEADLINE_MS = 45_000;
const LISTING_RETRY_MAX_SENDS = 32;
const LISTING_RETRY_RESEND_DELAY_MS = 1200;

/**
 * One-level directory listing client for the folder picker.
 *
 * React Query owns the per-path cache, the in-flight dedupe, the error state
 * and the abort signal that ends the Retry loop when the picker unmounts; the
 * query key `['list-directories', connectionId, path]` replaces the
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
 * A listing that has not answered within {@link LISTING_DEADLINE_MS} throws
 * that same plain `Error` instead of holding the skeleton past the picker's
 * budget. A plain open puts the listing on the wire once; the picker's Retry
 * gets the longer {@link LISTING_RETRY_DEADLINE_MS} budget and repeats the send,
 * so one tap can bridge a relay restart (see {@link LISTING_RETRY_MAX_SENDS}).
 */
export function useListDirectories(connectionId: string | null): UseListDirectoriesResult {
  const connection = useUserWebConnection();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string | null>(null);
  // One-shot flag: the next attempt is the picker's Retry and gets the bridge
  // budget. Read and cleared by the queryFn; see LISTING_RETRY_DEADLINE_MS.
  const retryBudgetRef = useRef(false);

  const query = useQuery<DirectoryEntry[]>({
    queryKey: ['list-directories', connectionId, path],
    queryFn: async ({ signal }) => {
      // `enabled` guarantees both are set; the guard narrows the types and
      // keeps the queryFn total for the impossible case.
      if (connectionId === null || path === null) {
        throw new Error('directory listing requested without a connection');
      }
      const isRetry = retryBudgetRef.current;
      retryBudgetRef.current = false;
      const deadlineAt = Date.now() + (isRetry ? LISTING_RETRY_DEADLINE_MS : LISTING_DEADLINE_MS);
      // A plain open has one send and reports the failure within its deadline;
      // only the Retry repeats the send while the transport recovers.
      const maxSends = isRetry ? LISTING_RETRY_MAX_SENDS : 1;
      let nudged = false;
      for (let send = 1; ; send += 1) {
        // React Query aborts this signal when the picker unmounts and clears
        // the connection's listings. The paced Retry must not keep sending for
        // a screen that is gone: stop before the next send. `withDeadline`
        // below takes the same signal, so an abort during a send settles that
        // wait immediately instead of holding it to its deadline.
        if (signal.aborted) {
          throw new Error('directory listing cancelled');
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          throw new Error('directory listing unavailable');
        }
        if (!nudged && !connection.isConnected()) {
          // The reconnect loop may have parked on a long backoff or exhausted
          // itself while the sheet sat on the error, and the send below would
          // then block in the SDK's open waiter until the deadline instead of
          // returning a failure the loop could react to. Nudge the transport
          // BEFORE waiting, so an attempt that starts just after the relay came
          // back rebuilds the socket instead of reporting the sheet's error;
          // the same nudge the session-connection indicator's Retry uses. A
          // connected socket is left alone — Retry must never tear down a
          // transport that already works.
          nudged = true;
          connection.retryConnection();
        }
        // eslint-disable-next-line no-await-in-loop -- each send must settle before the next: what the send failed with is what the next send reacts to
        const result = await withDeadline(
          remaining,
          async () => {
            const listing = await listDirectoriesOnConnection(
              connection,
              connectionId,
              path === '' ? undefined : path
            );
            return listing;
          },
          signal
        );
        if (result.ok) {
          return result.directories;
        }
        // Permanent for this connection; the marker keeps the phase terminal.
        if (result.reason !== 'transport') {
          throw new DirectoryListingUnsupported('directory listing unsupported');
        }
        if (send >= maxSends || deadlineAt - Date.now() <= LISTING_RETRY_RESEND_DELAY_MS) {
          // Retryable: React Query owns the error state, and `retry: false`
          // leaves the retry to the picker's Retry CTA.
          throw new Error('directory listing unavailable');
        }
        // eslint-disable-next-line no-await-in-loop -- the next send must wait out the reconnect the previous send failed on
        await new Promise<void>(resolve => {
          setTimeout(resolve, LISTING_RETRY_RESEND_DELAY_MS);
        });
      }
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
      // The Retry CTA repeats the path on screen. The attempt itself restarts
      // a parked transport before its first send and may bridge the
      // outage-recovery window (see LISTING_RETRY_DEADLINE_MS), so this only
      // has to flag the refetch as a retry and drop the query back to its
      // skeleton: a no-data refetch goes back to pending and clears the error
      // (`fetchState` in @tanstack/query-core), the phase the replaced
      // generation guard produced.
      const current = queryRef.current;
      // A repeat while the listing has not answered yet — a double-tapped Retry
      // or folder row — starts no second attempt: query-core ends the refetch on
      // the fetch already in flight (`continueRetry` in query.js, which returns
      // that fetch's promise without re-running the queryFn whenever a no-data
      // fetch is in flight), so the armed flag would never be read and the next
      // plain open would inherit the Retry budget instead of its own single
      // send and 12 s deadline. The attempt on screen is already the retry the
      // user asked for.
      if (current.fetchStatus !== 'idle' && current.data === undefined) {
        return;
      }
      retryBudgetRef.current = true;
      void current.refetch();
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
