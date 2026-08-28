import { useCallback, useEffect, useRef, useState } from 'react';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { type AuthenticatedOwner, isAuthenticatedOwner } from '@/lib/context-scope';
import {
  clearDraft,
  type DraftLoadResult,
  type DraftShapeValidator,
  flushDraft,
  isStringDraft,
  loadDraft,
  loadDraftResult,
  NEW_SESSION_DRAFT_KEY,
  saveDraft,
} from '@/lib/persist/drafts';
import { encryptedStoreRecovery, retryEncryptedKvOpen } from './encrypted-kv';
import { migrateLegacyDraft, parseScopedDraftKey } from './scoped-draft-keys';

type UseFencedDraftLoadInput<T> = {
  userId: string | undefined;
  isIdentityLoading: boolean;
  entityKey: string;
  validate?: DraftShapeValidator<T>;
};

/** Compatibility only: unchanged PR/review/share callers retain nullable restoration. */
export function useFencedDraftLoad<T = string>({
  userId,
  isIdentityLoading,
  entityKey,
  validate,
}: UseFencedDraftLoadInput<T>): { settled: boolean; value: T | null } {
  const resolvedValidateRef = useRef((validate ?? isStringDraft) as DraftShapeValidator<T>);
  resolvedValidateRef.current = (validate ?? isStringDraft) as DraftShapeValidator<T>;
  const epoch = currentAuthEpoch();
  const identity = JSON.stringify([epoch, userId, entityKey]);
  const activeIdentity = useRef(identity);
  const generation = useRef(0);
  if (activeIdentity.current !== identity) {
    activeIdentity.current = identity;
    generation.current += 1;
  }
  const [stored, setStored] = useState<{ identity: string; settled: boolean; value: T | null }>({
    identity,
    settled: false,
    value: null,
  });
  useEffect(() => {
    generation.current += 1;
    const attempt = generation.current;
    setStored({ identity, settled: false, value: null });
    if (!userId) {
      if (!isIdentityLoading) {
        setStored({ identity, settled: true, value: null });
      }
      return undefined;
    }
    void (async () => {
      const value = await loadDraft(userId, entityKey, resolvedValidateRef.current);
      if (attempt === generation.current && isCurrentAuthEpoch(epoch)) {
        setStored({ identity, settled: true, value });
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [identity, userId, entityKey, isIdentityLoading, epoch]);
  return stored.identity === identity
    ? { settled: stored.settled, value: stored.value }
    : { settled: false, value: null };
}

export type ScopedDraftState<T> = DraftLoadResult<T> | Readonly<{ status: 'unresolved' }>;
type ScopedDraftInput<T> = {
  owner: AuthenticatedOwner;
  entityKey: string;
  selectionGeneration: number;
  isReady: boolean;
  validate?: DraftShapeValidator<T>;
};

/** The restored result, not initial/prefilled text, grants access to every persistence action. */
export function useScopedDraftLoad<T = string>({
  owner,
  entityKey,
  selectionGeneration,
  isReady,
  validate,
}: ScopedDraftInput<T>) {
  const identity = JSON.stringify([
    owner.authEpoch,
    owner.generation,
    owner.userId,
    entityKey,
    selectionGeneration,
    isReady,
  ]);
  const activeIdentity = useRef(identity);
  const generation = useRef(0);
  const writeGeneration = useRef<number | null>(null);
  if (activeIdentity.current !== identity) {
    activeIdentity.current = identity;
    generation.current += 1;
    writeGeneration.current = null;
  }
  const validateRef = useRef((validate ?? isStringDraft) as DraftShapeValidator<T>);
  validateRef.current = (validate ?? isStringDraft) as DraftShapeValidator<T>;
  const [stored, setStored] = useState<{
    identity: string;
    generation: number;
    result: ScopedDraftState<T>;
  }>({ identity, generation: 0, result: { status: 'unresolved' } });
  const pending = useRef<{ identity: string; generation: number; promise: Promise<void> } | null>(
    null
  );

  const load = useCallback(
    async (retryStore: boolean): Promise<void> => {
      if (!isReady || activeIdentity.current !== identity || !isAuthenticatedOwner(owner)) {
        return;
      }
      if (
        pending.current?.identity === identity &&
        pending.current.generation === generation.current
      ) {
        return pending.current.promise;
      }
      generation.current += 1;
      writeGeneration.current = null;
      const attempt = generation.current;
      const isCurrent = () =>
        activeIdentity.current === identity &&
        generation.current === attempt &&
        isAuthenticatedOwner(owner);
      setStored({ identity, generation: attempt, result: { status: 'unresolved' } });
      const promise = (async () => {
        if (owner.userId === null || !isCurrent()) {
          return;
        }
        let result: ScopedDraftState<T> = { status: 'unresolved' };
        try {
          if (retryStore) {
            await retryEncryptedKvOpen();
          }
          if (!isCurrent()) {
            return;
          }
          result = parseScopedDraftKey(entityKey)
            ? await loadDraftResult(owner.userId, entityKey, validateRef.current, isCurrent)
            : { status: 'malformed', reason: 'shape' };
        } catch (error) {
          result = { status: 'failed', error };
        }
        if (isCurrent()) {
          writeGeneration.current =
            result.status === 'present' || result.status === 'absent' ? attempt : null;
          setStored({ identity, generation: attempt, result });
        }
      })();
      const flight = { identity, generation: attempt, promise };
      pending.current = flight;
      void (async () => {
        await promise;
        if (pending.current === flight) {
          pending.current = null;
        }
      })();
      await promise;
    },
    [identity, owner, entityKey, isReady]
  );

  useEffect(() => {
    void load(false);
    return () => {
      generation.current += 1;
    };
  }, [load]);
  const result: ScopedDraftState<T> =
    stored.identity === identity && stored.generation === generation.current
      ? stored.result
      : { status: 'unresolved' };
  const restored = result.status === 'present' || result.status === 'absent';
  const persistenceAllowed = () => isAuthenticatedOwner(owner);
  const allowed = () =>
    isReady &&
    persistenceAllowed() &&
    activeIdentity.current === identity &&
    stored.generation === generation.current &&
    stored.generation === writeGeneration.current &&
    restored;
  const retry = async () => {
    if (activeIdentity.current !== identity || !isAuthenticatedOwner(owner)) {
      return;
    }
    if (
      pending.current?.identity === identity &&
      pending.current.generation === generation.current
    ) {
      await pending.current.promise;
    } else if (
      stored.generation === generation.current &&
      (result.status === 'failed' || result.status === 'malformed')
    ) {
      await load(true);
    }
  };
  const save = (value: T) => {
    if (owner.userId !== null && allowed()) {
      // Context changes close new edits, not persistence already admitted to this owner and key.
      saveDraft(owner.userId, entityKey, value, persistenceAllowed);
    }
  };
  const flush = async () => {
    if (owner.userId !== null && restored && persistenceAllowed()) {
      await flushDraft(owner.userId, entityKey, persistenceAllowed);
    }
  };
  const clear = async () => {
    if (owner.userId === null || !allowed()) {
      return false;
    }
    const cleared = await clearDraft(owner.userId, entityKey, allowed);
    return cleared;
  };
  const importLegacy = async (candidateKey: string) => {
    if (!allowed()) {
      return 'stale' as const;
    }
    const outcome = await migrateLegacyDraft({
      owner,
      destinationKey: entityKey,
      candidateKey,
      selection: 'explicit',
      isCurrent: allowed,
    });
    if (outcome === 'committed' && allowed()) {
      await load(false);
    }
    return outcome;
  };
  return {
    status: result.status,
    result,
    value: result.status === 'present' ? result.value : null,
    canWrite: allowed(),
    isCurrent: allowed,
    recovery: result.status === 'failed' ? encryptedStoreRecovery(result.error) : null,
    retry,
    save,
    flush,
    clear,
    importLegacy,
  };
}

type UseRemoteSpawnDraftCleanupInput = {
  userId: string | undefined;
  /** New producers pass the exact captured scoped key; the fallback serves unchanged routes until a6. */
  entityKey?: string;
  isCurrent?: () => boolean;
};

/** Preserve the existing attempted-spawn leave policy, but never retarget its captured draft. */
export function useRemoteSpawnDraftCleanup({
  userId,
  entityKey = NEW_SESSION_DRAFT_KEY,
  isCurrent,
}: UseRemoteSpawnDraftCleanupInput) {
  const epoch = currentAuthEpoch();
  const identity = JSON.stringify([epoch, userId, entityKey]);
  const guard = useRef({ identity, isCurrent });
  guard.current = { identity, isCurrent };
  const attempted = useRef<typeof guard.current | null>(null);
  const markRemoteSpawnAttempted = useCallback(() => {
    const current = guard.current;
    if (
      current.identity === identity &&
      isCurrentAuthEpoch(epoch) &&
      (!current.isCurrent || current.isCurrent())
    ) {
      attempted.current = current;
    }
  }, [epoch, identity]);
  useEffect(
    () => () => {
      const current = guard.current;
      const allowed = () =>
        current.identity === identity &&
        isCurrentAuthEpoch(epoch) &&
        (!current.isCurrent || current.isCurrent());
      if (!userId || !allowed()) {
        return;
      }
      const attempt = attempted.current;
      if (attempt?.identity === identity && (!attempt.isCurrent || attempt.isCurrent())) {
        void clearDraft(
          userId,
          entityKey,
          () => allowed() && (!attempt.isCurrent || attempt.isCurrent())
        );
      } else {
        void flushDraft(userId, entityKey, allowed);
      }
    },
    [userId, entityKey, epoch, identity]
  );
  return { markRemoteSpawnAttempted };
}
