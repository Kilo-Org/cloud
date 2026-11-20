import { useShareIntentContext } from 'expo-share-intent';
import * as Sentry from '@sentry/react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import {
  resolveSupersededPendingShareId,
  shouldIngestShareIntent,
} from '@/lib/pending-share-navigation';
import {
  clearSharePayload,
  discardUnstoredSharePayload,
  loadPendingShareIdDraft,
  normalizeShareIntent,
  peekSharePayload,
  persistPendingShareIdDraft,
  putSharePayload,
  restoreSharePayloads,
  type ShareId,
  type SharePayload,
  subscribeAccountStagedShareClear,
} from '@/lib/share-payload';
import { restoreShareNavigation } from '@/lib/share-navigation';

/**
 * Owns the pending-share slot: the in-memory id the share gate opens on, and
 * the durable pending-share draft it restores from after process death. The
 * root layout keeps navigation (it opens the gate) and the shell-readiness
 * signal; this hook reads `useShareIntentContext` itself so share intake has
 * exactly one owner. The draft key lives in `@/lib/share-payload`, which also
 * owns the draft's value shape and flush.
 */
/** The pending-share slot and the release the layout's gate consume calls. */
export type PendingShareIntake = {
  readonly pendingShareId: ShareId | null;
  /** Bumps the epoch and clears the slot: the gate consumed this share. */
  readonly releasePendingShare: () => void;
};

export function usePendingShareIntake(input: {
  readonly userId: string | undefined;
  readonly isShellReady: boolean;
}): PendingShareIntake {
  const userId = input.userId;
  const isShellReady = input.isShellReady;

  const {
    hasShareIntent,
    shareIntent,
    resetShareIntent,
    error: shareIntentError,
  } = useShareIntentContext();
  // expo-share-intent rebuilds resetShareIntent every render; keep it out of
  // the ingest/error effect deps via ref (same pattern as share-prefill.ts).
  const resetShareIntentRef = useRef(resetShareIntent);
  resetShareIntentRef.current = resetShareIntent;
  const [pendingShareId, setPendingShareId] = useState<ShareId | null>(null);
  // Mirror pendingShareId so the ingest effect can release a superseded share
  // without reading stale state or adding the id to effect deps.
  const pendingShareIdRef = useRef(pendingShareId);
  pendingShareIdRef.current = pendingShareId;
  // Bumped by the ingest arm and the gate consume so the cold-start restore can
  // detect any live arm/consume during its async reads and skip the fill.
  const pendingShareIdEpochRef = useRef(0);

  // Staged share deliveries belong to the account that staged them. The shared
  // account boundary drops them, and this subscription resets the pending slot
  // in step, so the slot always describes a staged share that exists. The
  // epoch bump also abandons a cold-start restore that is in flight. The
  // notification fires only when a stamped entry was dropped, so a share staged
  // before an account resolves keeps its slot for a same-process sign-in
  // (DEC-01).
  useEffect(
    () =>
      subscribeAccountStagedShareClear(() => {
        pendingShareIdEpochRef.current += 1;
        setPendingShareId(null);
      }),
    []
  );

  // Cold-start share restore. Order matters: payloads first, then the
  // navigation queue (deliveries point at restored payloads), then the pending
  // id — and only when its payload still exists. A restored id with an empty
  // map is the existing stale-share empty path, so it must not re-arm the gate.
  useEffect(() => {
    let cancelled = false;

    async function restoreShare() {
      const startEpoch = pendingShareIdEpochRef.current;
      if (!userId) {
        return;
      }
      await restoreSharePayloads(userId);
      if (cancelled || pendingShareIdEpochRef.current !== startEpoch) {
        return;
      }
      await restoreShareNavigation(userId);
      // `cancelled` is set by the cleanup below; the previous check narrows the
      // fall-through path, but the variable is genuinely mutable.
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition
      if (cancelled || pendingShareIdEpochRef.current !== startEpoch) {
        return;
      }
      const pendingId = await loadPendingShareIdDraft(userId);
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition
      if (cancelled || pendingShareIdEpochRef.current !== startEpoch) {
        return;
      }
      if (
        pendingId !== null &&
        peekSharePayload(pendingId) !== null &&
        pendingShareIdRef.current === null
      ) {
        // Fill only an empty slot: a live ingest that armed a newer pending id
        // during this restore must win, so never overwrite a non-null slot.
        setPendingShareId(pendingId);
      }
    }

    void restoreShare();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (shareIntentError) {
      Sentry.captureException(new Error('Share intent provider error'), {
        tags: {
          'error.subsystem': 'share-intent',
          'error.operation': 'read_native_payload',
        },
        fingerprint: ['share-intent-provider-error'],
      });
      toast.error(i18n.t('share.couldNotReadContent'));
      resetShareIntentRef.current();
    }
  }, [shareIntentError]);

  // Keyed per shareIntent identity so a newer intent cancels and supersedes
  // an in-flight ingest. Success/failure reset for the happy path lives here
  // (gate must never reset); the shareIntentError effect also resets on the
  // error path. Calls go through resetShareIntentRef so the unstable context
  // function stays out of the deps.
  useEffect(() => {
    // Copy the shared files only once the shell can open the gate. The
    // provider keeps the intent across a backgrounding (SHARE_INTENT_OPTIONS)
    // so a sign-in that leaves the app cannot drop the deferred payload.
    if (!shouldIngestShareIntent({ hasShareIntent, isShellReady })) {
      return undefined;
    }

    let cancelled = false;

    const ingestShareIntent = async () => {
      try {
        const payload: SharePayload = await normalizeShareIntent(shareIntent);
        if (cancelled) {
          // Superseded mid-copy: never stored, so no lifecycle path can clean it.
          discardUnstoredSharePayload(payload);
          return;
        }
        const shareId = putSharePayload(payload);
        resetShareIntentRef.current();
        // Latest-wins: a superseded pending share is released — never silently orphaned.
        const superseded = resolveSupersededPendingShareId(pendingShareIdRef.current, shareId);
        if (superseded !== null) {
          clearSharePayload(superseded);
        }
        pendingShareIdEpochRef.current += 1;
        setPendingShareId(shareId);
        // Persist the pending id so a process death before the gate opens still
        // restores it; skipped while the account has not resolved (signed out).
        if (userId) {
          void persistPendingShareIdDraft(userId, shareId);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        Sentry.captureException(error, {
          tags: { 'error.subsystem': 'share-intent', 'error.operation': 'normalize_payload' },
        });
        toast.error(i18n.t('share.couldNotReadContent'));
        resetShareIntentRef.current();
      }
    };

    void ingestShareIntent();

    return () => {
      cancelled = true;
    };
  }, [hasShareIntent, shareIntent, isShellReady, userId]);

  // Consume the pending share so the gate never re-opens on it: the layout's
  // gate effect navigates first, then releases the slot.
  const releasePendingShare = useCallback(() => {
    pendingShareIdEpochRef.current += 1;
    setPendingShareId(null);
  }, []);

  return { pendingShareId, releasePendingShare };
}
