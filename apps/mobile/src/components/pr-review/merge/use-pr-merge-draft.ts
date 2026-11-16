import { useCallback, useMemo, useRef, useState } from 'react';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { clearDraft, prMergeDraftKey, saveDraft } from '@/lib/persist/drafts';
import { isMergeDraft, type MergeDraft } from '@/lib/persist/merge-draft';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import {
  defaultCommitMessage,
  defaultCommitTitle,
} from '@/lib/pr-review/merge/merge-commit-defaults';
import {
  type AllowedMergeMethod,
  isAllowedMergeMethod,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';

// The native inputs stay uncontrolled; writing their refs also schedules persistence.
function savingRef<T>(target: { current: T }, onWrite: () => void) {
  return new Proxy(target, {
    set(obj, prop, value) {
      if (prop === 'current') {
        obj.current = value as T;
        onWrite();
        return true;
      }
      return Reflect.set(obj, prop, value);
    },
  });
}

export function usePrMergeDraft({
  owner,
  repoName,
  number,
  title,
  bodyMarkdown,
  prRef,
  allowedMethods,
  fallbackMethod,
}: Readonly<{
  owner: string;
  repoName: string;
  number: number;
  title: string;
  bodyMarkdown: string | null;
  prRef?: ProviderPrRef;
  allowedMethods: AllowedMergeMethod[];
  fallbackMethod: AllowedMergeMethod;
}>) {
  const titleRef = useRef(defaultCommitTitle(title, number));
  const messageRef = useRef(defaultCommitMessage(bodyMarkdown));
  const [method, setMethodState] = useState<AllowedMergeMethod>(fallbackMethod);
  // The save reads the ref, so a write never waits for the next render.
  const methodRef = useRef<AllowedMergeMethod>(fallbackMethod);
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const positionDraftKey = prMergeDraftKey(owner, repoName, number);
  const mergeDraftKey = prRef ? `${positionDraftKey}@${providerPrRefKey(prRef)}` : positionDraftKey;
  const draft = useFencedDraftLoad<MergeDraft>({
    userId,
    isIdentityLoading,
    entityKey: mergeDraftKey,
    validate: isMergeDraft,
  });
  const draftSeedKeyRef = useRef<string | null>(null);
  // Only fields the person authored are persisted: the derived defaults are a
  // rendering of the PR, not their work, and writing them back would restore
  // stale text after the PR changes, while a body over the draft byte cap would
  // drop the whole record and lose the chosen method with it.
  const authoredRef = useRef({ title: false, message: false, method: false });
  const draftSeedKey = `${userId ?? 'anonymous'}\u0000${mergeDraftKey}`;
  // The settled gate unmounts inputs while identity/destination changes; seed only that generation.
  if (draft.settled && draftSeedKeyRef.current !== draftSeedKey) {
    draftSeedKeyRef.current = draftSeedKey;
    const stored = draft.value;
    const restored = stored?.method;
    const next =
      restored !== undefined && isAllowedMergeMethod(restored) && allowedMethods.includes(restored)
        ? restored
        : fallbackMethod;
    authoredRef.current = {
      title: stored?.title !== undefined,
      message: stored?.message !== undefined,
      // A method this build cannot restore is not this build's to write back:
      // another build wrote it, and its record stays loadable there.
      method: next === restored,
    };
    titleRef.current = stored?.title ?? defaultCommitTitle(title, number);
    messageRef.current = stored?.message ?? defaultCommitMessage(bodyMarkdown);
    methodRef.current = next;
    setMethodState(next);
  }

  const saveMergeDraft = useCallback(() => {
    if (userId) {
      const authored = authoredRef.current;
      saveDraft(userId, mergeDraftKey, {
        ...(authored.title ? { title: titleRef.current } : {}),
        ...(authored.message ? { message: messageRef.current } : {}),
        ...(authored.method ? { method: methodRef.current } : {}),
      });
    }
  }, [userId, mergeDraftKey]);
  const titleSaveRef = useMemo(
    () =>
      savingRef(titleRef, () => {
        authoredRef.current.title = true;
        saveMergeDraft();
      }),
    [saveMergeDraft]
  );
  const messageSaveRef = useMemo(
    () =>
      savingRef(messageRef, () => {
        authoredRef.current.message = true;
        saveMergeDraft();
      }),
    [saveMergeDraft]
  );
  useDraftFlushOnBackground(userId, mergeDraftKey, true);

  const selectMethod = useCallback(
    (next: AllowedMergeMethod) => {
      methodRef.current = next;
      authoredRef.current.method = true;
      setMethodState(next);
      saveMergeDraft();
    },
    [saveMergeDraft]
  );

  const clearMergeDraft = useCallback(() => {
    if (userId) {
      void clearDraft(userId, mergeDraftKey);
    }
  }, [userId, mergeDraftKey]);

  return {
    settled: draft.settled,
    titleRef,
    messageRef,
    titleSaveRef,
    messageSaveRef,
    method,
    selectMethod,
    clearMergeDraft,
  };
}
