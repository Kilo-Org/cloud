import { useCallback, useMemo, useRef } from 'react';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { clearDraft, isMergeDraft, prMergeDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import {
  defaultCommitMessage,
  defaultCommitTitle,
} from '@/lib/pr-review/merge/merge-commit-defaults';
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
}: Readonly<{
  owner: string;
  repoName: string;
  number: number;
  title: string;
  bodyMarkdown: string | null;
  prRef?: ProviderPrRef;
}>) {
  const titleRef = useRef(defaultCommitTitle(title, number));
  const messageRef = useRef(defaultCommitMessage(bodyMarkdown));
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const positionDraftKey = prMergeDraftKey(owner, repoName, number);
  const mergeDraftKey = prRef ? `${positionDraftKey}@${providerPrRefKey(prRef)}` : positionDraftKey;
  const draft = useFencedDraftLoad<{ title: string; message: string }>({
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
  }

  const saveMergeDraft = useCallback(() => {
    if (userId) {
      saveDraft(userId, mergeDraftKey, { title: titleRef.current, message: messageRef.current });
    }
  }, [userId, mergeDraftKey]);
  const titleSaveRef = useMemo(() => savingRef(titleRef, saveMergeDraft), [saveMergeDraft]);
  const messageSaveRef = useMemo(() => savingRef(messageRef, saveMergeDraft), [saveMergeDraft]);
  useDraftFlushOnBackground(userId, mergeDraftKey, true);

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
    clearMergeDraft,
  };
}
