import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  clearDraft,
  draftScope,
  loadDraft,
  saveDraft,
  securityDismissDraftKey,
} from '@/lib/persist/drafts';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';

/**
 * Durable dismiss-intent draft for one finding (P1-B-19b). The draft records
 * the user's chosen reason and comment, plus the last pre-accept failure
 * (`lastError`) and its retry class (`retryable`). A null `lastError` means the
 * intent is still in flight or just submitted; a non-null value means the
 * mutation failed before the server accepted a command id, so no command
 * observer will ever reconcile it — the retry card must.
 */
const SecurityDismissDraftSchema = z.object({
  reason: z.string(),
  comment: z.string(),
  lastError: z.string().nullable(),
  retryable: z.boolean().nullable(),
});

export type SecurityDismissDraft = z.infer<typeof SecurityDismissDraftSchema>;

/** Runtime shape guard for a persisted dismiss draft, passed to `loadDraft`. */
export function isSecurityDismissDraft(value: unknown): value is SecurityDismissDraft {
  return SecurityDismissDraftSchema.safeParse(value).success;
}

type SecurityDismissDraftController = {
  /** The loaded draft, or null when absent or not yet hydrated. */
  draft: SecurityDismissDraft | null;
  /** True once the stored draft has been read (or skipped without a user). */
  hydrated: boolean;
  /** Writes the draft (debounced) and updates the in-memory copy. */
  persist: (draft: SecurityDismissDraft) => void;
  /** Removes the stored draft and clears the in-memory copy. */
  clear: () => void;
  /** Re-reads the stored draft, so a parent that stays mounted refreshes. */
  refresh: () => void;
};

/**
 * Loads, writes, and clears the dismiss draft for one finding. Hydration reads
 * the stored draft once on mount; a later account or finding change remounts
 * the load, and `refresh` re-reads in place for a parent that stays mounted
 * while the dismiss sheet is open. Persistence is skipped until the user id is
 * known, and the debounced write is flushed on unmount and app background.
 */
export function useSecurityDismissDraft(
  scope: string,
  findingId: string
): SecurityDismissDraftController {
  const { userId } = useCurrentUserId();
  const entityKey = securityDismissDraftKey(scope, findingId);
  const [draft, setDraft] = useState<SecurityDismissDraft | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const generationRef = useRef(0);

  // Flush the debounced write on unmount and app background, so a kill inside
  // the 500 ms window does not drop the last edit.
  useDraftFlushOnBackground(userId, entityKey, true);

  const refresh = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!userId) {
      // No account: nothing to read, so the form is usable empty.
      setHydrated(true);
      return;
    }
    void (async () => {
      const restored = await loadDraft(userId, entityKey, isSecurityDismissDraft);
      if (generationRef.current !== generation) {
        return;
      }
      setDraft(restored);
      setHydrated(true);
    })();
  }, [userId, entityKey]);

  useEffect(() => {
    refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  const persist = (next: SecurityDismissDraft) => {
    setDraft(next);
    if (userId) {
      saveDraft(userId, entityKey, next);
    }
  };

  const clear = () => {
    setDraft(null);
    if (userId) {
      void clearDraft(userId, entityKey);
    }
  };

  return { draft, hydrated, persist, clear, refresh };
}

const SECURITY_DISMISS_KEY_PREFIX = 'security-dismiss:';

/** One failed dismissal in a scope, narrowed to the card's needs. */
export type SecurityDismissFailure = {
  findingId: string;
  lastError: string;
  retryable: boolean | null;
};

/**
 * Lists every dismiss draft in one scope whose `lastError` is non-null (a
 * pre-accept failure that no command observer will reconcile). Used by the
 * dashboard to render one retry card per failed dismissal.
 */
export async function listSecurityDismissFailures(
  userId: string,
  scope: string
): Promise<SecurityDismissFailure[]> {
  const prefix = `${SECURITY_DISMISS_KEY_PREFIX}${scope}:`;
  const entries = await encryptedKv.listEntries(draftScope(userId));
  const inScope = entries.filter(entry => entry.k.startsWith(prefix));
  const loaded = await Promise.all(
    inScope.map(async entry => {
      const findingId = entry.k.slice(prefix.length);
      const draft = await loadDraft(userId, entry.k, isSecurityDismissDraft);
      return { findingId, draft };
    })
  );
  const failures: SecurityDismissFailure[] = [];
  for (const { findingId, draft } of loaded) {
    if (draft !== null && draft.lastError !== null) {
      failures.push({ findingId, lastError: draft.lastError, retryable: draft.retryable });
    }
  }
  return failures;
}

/**
 * Reads the scope's failed dismiss drafts once on mount and exposes a `clear`
 * that removes one finding's draft and a `refresh` that re-reads in place for
 * a parent that stays mounted while the dismiss sheet is open. Returns an
 * empty list until the read settles, so the dashboard never flashes a card
 * before the store answers.
 */
export function useSecurityDismissFailures(scope: string) {
  const { userId } = useCurrentUserId();
  const [failures, setFailures] = useState<SecurityDismissFailure[]>([]);
  const generationRef = useRef(0);

  const refresh = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!userId) {
      setFailures([]);
      return;
    }
    void (async () => {
      const found = await listSecurityDismissFailures(userId, scope);
      if (generationRef.current !== generation) {
        return;
      }
      setFailures(found);
    })();
  }, [userId, scope]);

  useEffect(() => {
    refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  const clear = (findingId: string) => {
    setFailures(previous => previous.filter(failure => failure.findingId !== findingId));
    if (userId) {
      void clearDraft(userId, securityDismissDraftKey(scope, findingId));
    }
  };

  return { failures, clear, refresh };
}
