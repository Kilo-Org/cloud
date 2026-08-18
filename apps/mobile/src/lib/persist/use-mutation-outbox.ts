import { useCallback, useEffect, useRef, useState } from 'react';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  listOutboxRows,
  type OutboxRow,
  removeOutboxRow,
  writeOutboxRow,
} from '@/lib/persist/mutation-outbox';

/**
 * What one load did: applied its rows, failed to read them, or was superseded
 * by a newer load (identity change or an explicit refresh) and applied nothing.
 */
type LoadOutcome = 'loaded' | 'failed' | 'superseded';

/** A row the caller supplies; the taxonomy is forced by the write helper. */
export type OutboxRowInput = {
  operationKey: string;
  fingerprint: string;
  input: unknown;
};

/**
 * Loads the current user's outbox rows on launch and exposes the two write
 * paths plus key reuse (P1-E-40c).
 *
 * - `getStoredOperationKey` returns the stored `operationKey` for a matching
 *   `safe-retry` fingerprint, or null. A caller must check this BEFORE minting
 *   a new key, so a relaunch reuses the stored key instead of minting a new
 *   UUID. `reconcile-first` rows never contribute a key: they are never
 *   auto-replayed.
 * - `loaded` is false until the launch load settles (or the identity resolves
 *   to no user). `whenLoaded` resolves at that point, so a submit can gate on
 *   the load and read the freshly-loaded rows instead of minting a key over
 *   an unread stored row. It resolves `false` when the stored rows could not
 *   be read: the caller must refuse the mutation instead of minting a key over
 *   a row whose POST the server may already have accepted. A refused attempt
 *   re-reads the store, so the user's retry can succeed.
 * - `writeSafeRetry` / `writeReconcileFirst` persist a row under the forced
 *   taxonomy. `never-replay` has no write helper and is never enqueued.
 * - Both write helpers preserve an existing stored row's `operationKey` for the
 *   same fingerprint: a fresh in-memory key must never overwrite it.
 * - `writeReconcileFirst` requires a `scope` so a dashboard can filter
 *   `needsReconcile` to its own scope.
 * - `needsReconcile` surfaces the `reconcile-first` rows that must show a card
 *   instead of auto-POSTing. `remove` and `refresh` keep that list current.
 */
export function useMutationOutbox(): {
  getStoredOperationKey: (fingerprint: string) => string | null;
  writeSafeRetry: (row: OutboxRowInput) => Promise<void>;
  writeReconcileFirst: (row: OutboxRowInput & { scope: string }) => Promise<string>;
  remove: (fingerprint: string) => Promise<void>;
  needsReconcile: OutboxRow[];
  loaded: boolean;
  whenLoaded: () => Promise<boolean>;
  refresh: () => void;
} {
  const { userId, isLoading } = useCurrentUserId();
  const [rows, setRows] = useState<OutboxRow[]>([]);
  // Latest rows, readable without a stale closure: a submit that awaits the
  // load must read the freshly-loaded rows, not the rows captured at render.
  const rowsRef = useRef<OutboxRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const loadFailedRef = useRef(false);
  const waitersRef = useRef<(() => void)[]>([]);

  const markLoaded = useCallback(() => {
    if (loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    setLoaded(true);
    const waiters = waitersRef.current;
    waitersRef.current = [];
    for (const resolve of waiters) {
      resolve();
    }
  }, []);

  const resetLoaded = useCallback(() => {
    loadedRef.current = false;
    setLoaded(false);
  }, []);

  // Generation fence: a load applies only when its captured generation is
  // still current (a ref dodges type-aware flow narrowing, same pattern as
  // useFencedDraftLoad).
  const loadGenerationRef = useRef(0);

  // Single loader for the launch load, `refresh`, and a `whenLoaded` retry. A
  // superseded load applies nothing and marks nothing: the load that
  // superseded it releases the waiters, so `loaded` stays generation-fenced.
  const runLoad = useCallback(async (): Promise<LoadOutcome> => {
    loadGenerationRef.current += 1;
    const generation = loadGenerationRef.current;
    if (!userId) {
      rowsRef.current = [];
      setRows([]);
      loadFailedRef.current = false;
      markLoaded();
      return 'loaded';
    }
    const loadedRows = await listOutboxRows(userId);
    if (loadGenerationRef.current !== generation) {
      return 'superseded';
    }
    if (loadedRows === null) {
      // Marked loaded even though the read failed: `whenLoaded` reports the
      // failure and retries, so a waiter is never left hanging.
      loadFailedRef.current = true;
      markLoaded();
      return 'failed';
    }
    loadFailedRef.current = false;
    rowsRef.current = loadedRows;
    setRows(loadedRows);
    markLoaded();
    return 'loaded';
  }, [userId, markLoaded]);

  const whenLoaded = useCallback(async (): Promise<boolean> => {
    if (!loadedRef.current) {
      await new Promise<void>(resolve => {
        waitersRef.current.push(resolve);
      });
    }
    // A failed read must never pass as "no stored rows"; re-read so the user's
    // retry can succeed, and report the failure so the caller refuses.
    return loadFailedRef.current ? (await runLoad()) === 'loaded' : true;
  }, [runLoad]);

  // `loaded` stays false while the identity is still resolving, so a submit
  // cannot read rows before the user is known.
  useEffect(() => {
    if (isLoading) {
      loadGenerationRef.current += 1;
      rowsRef.current = [];
      setRows([]);
      resetLoaded();
      return undefined;
    }
    resetLoaded();
    void runLoad();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [isLoading, runLoad, resetLoaded]);

  const getStoredOperationKey = useCallback((fingerprint: string): string | null => {
    const row = rowsRef.current.find(
      r => r.fingerprint === fingerprint && r.taxonomy === 'safe-retry'
    );
    return row?.operationKey ?? null;
  }, []);

  const writeSafeRetry = useCallback(
    async (row: OutboxRowInput): Promise<void> => {
      if (!userId) {
        return;
      }
      // A stored safe-retry row owns its operationKey: a relaunch must reuse
      // it, so a fresh in-memory key must never overwrite the stored one.
      const stored = rowsRef.current.find(
        r => r.fingerprint === row.fingerprint && r.taxonomy === 'safe-retry'
      );
      const operationKey = stored?.operationKey ?? row.operationKey;
      await writeOutboxRow(userId, { ...row, operationKey, taxonomy: 'safe-retry' });
    },
    [userId]
  );

  const writeReconcileFirst = useCallback(
    async (row: OutboxRowInput & { scope: string }): Promise<string> => {
      if (!userId) {
        return row.operationKey;
      }
      // A stored reconcile-first row owns its operationKey: a "Sync now" that
      // races a crash row must not replace the stored key with a fresh
      // in-memory key, or the reconcile retry would POST the wrong key. The
      // resolved key is returned so the caller POSTs the row's own key.
      const stored = rowsRef.current.find(
        r => r.fingerprint === row.fingerprint && r.taxonomy === 'reconcile-first'
      );
      const operationKey = stored?.operationKey ?? row.operationKey;
      await writeOutboxRow(userId, { ...row, operationKey, taxonomy: 'reconcile-first' });
      return operationKey;
    },
    [userId]
  );

  const remove = useCallback(
    async (fingerprint: string): Promise<void> => {
      if (!userId) {
        return;
      }
      await removeOutboxRow(userId, fingerprint);
      rowsRef.current = rowsRef.current.filter(r => r.fingerprint !== fingerprint);
      setRows(previous => previous.filter(r => r.fingerprint !== fingerprint));
    },
    [userId]
  );

  const refresh = useCallback(() => {
    void runLoad();
  }, [runLoad]);

  const needsReconcile = rows.filter(r => r.taxonomy === 'reconcile-first');

  return {
    getStoredOperationKey,
    writeSafeRetry,
    writeReconcileFirst,
    remove,
    needsReconcile,
    loaded,
    whenLoaded,
    refresh,
  };
}
