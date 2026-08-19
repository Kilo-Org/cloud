import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearDraft,
  type DraftShapeValidator,
  flushDraft,
  isStringDraft,
  loadDraft,
  NEW_SESSION_DRAFT_KEY,
} from '@/lib/persist/drafts';

type UseFencedDraftLoadInput<T> = {
  userId: string | undefined;
  isIdentityLoading: boolean;
  /** Full draft entity key under `draft:<userId>` (e.g. `agent-composer:new`). */
  entityKey: string;
  /** Shape validator for the loaded value; defaults to a string draft. */
  validate?: DraftShapeValidator<T>;
};

/**
 * Loads a durable draft under `draft:<userId>` once per identity/entity
 * generation. Resets to the not-settled state whenever the identity or entity
 * changes, and only the newest generation's load may publish: every effect run
 * captures the current generation and every cleanup (unmount or a superseding
 * run) bumps it, so a load started for an older account or session can never
 * publish into the newest screen. `value` stays null until a stored draft (or
 * the absence of one) has loaded. The draft shape is the caller's contract:
 * pass a `validate` guard for a non-string draft, or omit it for a string.
 */
export function useFencedDraftLoad<T = string>({
  userId,
  isIdentityLoading,
  entityKey,
  validate,
}: UseFencedDraftLoadInput<T>): {
  settled: boolean;
  value: T | null;
} {
  const resolvedValidate = (validate ?? isStringDraft) as DraftShapeValidator<T>;
  // Hold the resolved validator in a ref so the effect's dependency array stays
  // limited to the identity/entity generation (the validator is a stable
  // module-level guard for every caller).
  const resolvedValidateRef = useRef(resolvedValidate);
  resolvedValidateRef.current = resolvedValidate;
  const [draftState, setDraftState] = useState<{ settled: boolean; value: T | null }>({
    settled: false,
    value: null,
  });
  // Reset the settled draft state when the identity or entity changes, so the
  // prompt stays hidden while the new generation's draft loads and never
  // shows the previous account's or session's draft.
  const draftIdentity = `${userId ?? 'anonymous'}\u0000${entityKey}`;
  const [prevDraftIdentity, setPrevDraftIdentity] = useState(draftIdentity);
  // The reset must be visible on THIS render, not the next: a deferred
  // setDraftState would still return the previous account's or entity's
  // settled value here, and a surface seeding from that stale value would
  // pin the old text to the new key.
  const identityChanged = prevDraftIdentity !== draftIdentity;
  if (identityChanged) {
    setPrevDraftIdentity(draftIdentity);
    setDraftState({ settled: false, value: null });
  }
  // Generation fence: a load applies only when its captured generation is
  // still current. Cleanup (unmount or a superseding run) bumps the
  // generation, so a stale load can never publish after a newer run armed
  // itself (refs dodge type-aware flow narrowing).
  const draftLoadGenerationRef = useRef(0);
  useEffect(() => {
    draftLoadGenerationRef.current += 1;
    const generation = draftLoadGenerationRef.current;
    if (!userId) {
      if (!isIdentityLoading) {
        setDraftState({ settled: true, value: null });
      }
      return undefined;
    }
    void (async () => {
      const value = await loadDraft(userId, entityKey, resolvedValidateRef.current);
      if (draftLoadGenerationRef.current === generation) {
        setDraftState({ settled: true, value: value ?? null });
      }
    })();
    return () => {
      draftLoadGenerationRef.current += 1;
    };
  }, [userId, isIdentityLoading, entityKey]);
  return identityChanged ? { settled: false, value: null } : draftState;
}

type UseRemoteSpawnDraftCleanupInput = {
  userId: string | undefined;
};

/**
 * Owns the new-session draft's fate when the screen leaves after a remote
 * spawn attempt. The spawn dispatch consumes the outcome internally — a
 * success replaces the screen, a failure toasts and stays — and the route
 * arms the attempt marker only once the dispatch admits the spawn (voice
 * settlement and remote admission passed). The route's observable signal is
 * therefore the attempt marker plus the unmount itself: a successful spawn is
 * the one path that unmounts the screen with an attempt recorded. The leaving
 * route clears the consumed `agent-composer:new` entry (the prompt must not
 * reappear on the next new-session visit) instead of flushing it. Without an
 * attempt the unmount flushes the pending debounce, preserving the draft for
 * a normal leave (back button) or a tap that stopped before any spawn attempt
 * (blocked admission, cancelled voice submit).
 *
 * Boundary: a failed spawn followed by a manual leave also clears the draft.
 * The failed spawn itself never clears — the screen stays mounted, so the
 * retry-while-on-screen contract holds — and the recorded trade-off is that a
 * user who abandons the screen after a failed attempt loses the prompt, the
 * same as if the attempt had succeeded.
 */
export function useRemoteSpawnDraftCleanup({ userId }: UseRemoteSpawnDraftCleanupInput): {
  markRemoteSpawnAttempted: () => void;
} {
  const spawnAttemptedRef = useRef(false);
  const markRemoteSpawnAttempted = useCallback(() => {
    spawnAttemptedRef.current = true;
  }, []);
  useEffect(
    () => () => {
      if (!userId) {
        return;
      }
      if (spawnAttemptedRef.current) {
        void clearDraft(userId, NEW_SESSION_DRAFT_KEY);
      } else {
        void flushDraft(userId, NEW_SESSION_DRAFT_KEY);
      }
    },
    [userId]
  );
  return { markRemoteSpawnAttempted };
}
