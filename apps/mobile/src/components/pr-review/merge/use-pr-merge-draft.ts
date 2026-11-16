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
import { type AllowedMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';
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
  const draftSeedKey = `${userId ?? 'anonymous'}\u0000${mergeDraftKey}`;
  // The settled gate unmounts inputs while identity/destination changes; seed only that generation.
  if (draft.settled && draftSeedKeyRef.current !== draftSeedKey) {
    draftSeedKeyRef.current = draftSeedKey;
    titleRef.current = draft.value?.title ?? defaultCommitTitle(title, number);
    messageRef.current = draft.value?.message ?? defaultCommitMessage(bodyMarkdown);
    const restored = draft.value?.method;
    const next = restored && allowedMethods.includes(restored) ? restored : fallbackMethod;
    methodRef.current = next;
    setMethodState(next);
  }

  const saveMergeDraft = useCallback(() => {
    if (userId) {
      saveDraft(userId, mergeDraftKey, {
        title: titleRef.current,
        message: messageRef.current,
        method: methodRef.current,
      });
    }
  }, [userId, mergeDraftKey]);
  const titleSaveRef = useMemo(() => savingRef(titleRef, saveMergeDraft), [saveMergeDraft]);
  const messageSaveRef = useMemo(() => savingRef(messageRef, saveMergeDraft), [saveMergeDraft]);
  useDraftFlushOnBackground(userId, mergeDraftKey, true);

  const selectMethod = useCallback(
    (next: AllowedMergeMethod) => {
      methodRef.current = next;
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
