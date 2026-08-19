/* eslint-disable max-lines -- the merge sheet owns the durable merge draft (load, save, seed, clear) beside the existing merge/auto-merge form; the draft wiring stays with the form it persists */
// S8 merge sheet. The orchestrator mounts this inside the
// `[owner]/[repo]/[number]/merge.tsx` route; the orchestrator-wired
// `PrReviewMergeScreen` fetches the overview DTO, derives the form's
// initial state, and forwards everything as props.
//
// Two modes share the same form:
//   - 'merge'              — submits `mergePullRequest`
//   - 'enable-auto-merge'  — submits `enableAutoMerge`
//
// Toasts paint behind formSheets on iOS, so this sheet ALSO renders
// inline errors while the underlying mutation hook still calls
// `toast.error` in `onError`. The form stays open until the user
// dismisses (cancel) or the mutation succeeds (auto-dismiss).

import * as Haptics from 'expo-haptics';
import { Alert, Keyboard, ScrollView, type TextInput, useWindowDimensions } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import {
  type AllowedMergeMethod,
  type PrMergeMethod,
  type PrOverviewRepoSettings,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import {
  useEnableAutoMergeMutation,
  useMergePullRequestMutation,
} from '@/lib/pr-review/merge/use-pr-merge-mutations';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  isPrOperationPersistenceFailed,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import { applyMergeSuccessEffects } from '@/lib/pr-review/merge/merge-success-effects';
import {
  defaultMergeMethodOptionFor,
  mergeMethodOptionsFor,
} from '@/components/pr-review/merge/pr-merge-icons';
import { MergeSheetFormBody } from '@/components/pr-review/merge/pr-merge-sheet-parts';
import {
  defaultCommitMessage,
  defaultCommitTitle,
} from '@/lib/pr-review/merge/merge-commit-defaults';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { clearDraft, isMergeDraft, prMergeDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';

type PrMergeSheetMode = 'merge' | 'enable-auto-merge';

type PrMergeSheetProps = Readonly<{
  owner: string;
  /** The GitHub repository name (the `repo` path segment, not the settings object). */
  repoName: string;
  number: number;
  headSha: string;
  headRef: string;
  isCrossRepo: boolean;
  prNodeId: string;
  title: string;
  bodyMarkdown: string | null;
  baseRef: string;
  repo: PrOverviewRepoSettings;
  initialMethod: PrMergeMethod;
  mode: PrMergeSheetMode;
  sheetTitle: string;
  eyebrow: string;
  /** Called after a successful merge / auto-merge enable so the orchestrator can refetch. */
  onRefetch: () => Promise<void>;
  /** Called when the user cancels or after a successful submit. */
  onDismiss: () => void;
}>;

type MergePullRequestInput = {
  owner: string;
  repo: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
  deleteBranch: boolean;
  expectedHeadSha: string;
};

type AutoMergeInput = {
  owner: string;
  repo: string;
  number: number;
  prNodeId: string;
  method?: 'MERGE' | 'SQUASH' | 'REBASE';
  commitTitle?: string;
  commitMessage?: string;
};

/**
 * Wraps an uncontrolled-input ref so every `.current` write (the parts file's
 * `onChangeText`) also fires `onWrite`. The merge sheet owns the save but the
 * input handlers live in `pr-merge-sheet-parts.tsx`; the proxy hooks the write
 * without touching that file.
 */
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

export function PrMergeSheet(props: PrMergeSheetProps) {
  const {
    owner,
    repoName,
    number,
    headSha,
    isCrossRepo,
    prNodeId,
    title,
    bodyMarkdown,
    repo: repoSettings,
    initialMethod,
    mode,
    sheetTitle,
    eyebrow,
    onRefetch,
    onDismiss,
  } = props;

  const methodOptions = useMemo(() => mergeMethodOptionsFor(repoSettings), [repoSettings]);
  const safeInitial: AllowedMergeMethod = useMemo(
    () =>
      methodOptions.find(o => o.value === initialMethod)?.value ??
      defaultMergeMethodOptionFor(repoSettings),
    [initialMethod, methodOptions, repoSettings]
  );
  const [method, setMethod] = useState<AllowedMergeMethod>(safeInitial);

  const showDeleteBranchToggle = !isCrossRepo;
  const [deleteBranch, setDeleteBranch] = useState<boolean>(repoSettings.deleteBranchOnMerge);

  // iOS uncontrolled-input pattern: store text in a ref via onChangeText,
  // use state only for derived UI (the inline error from a failed submit),
  // read the ref on submit. `defaultValue` is for the first commit only.
  const titleInputRef = useRef<TextInput>(null);
  const messageInputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const titleRef = useRef(defaultCommitTitle(title, number));
  const messageRef = useRef(defaultCommitMessage(bodyMarkdown));
  const { height: windowHeight } = useWindowDimensions();

  // Durable merge draft. Identity gates save/restore: nothing is written or
  // read while the user id is unknown. The inputs render only once the draft
  // settles, seeded from the stored value or today's defaults.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const mergeDraftKey = prMergeDraftKey(owner, repoName, number);
  const draft = useFencedDraftLoad<{ title: string; message: string }>({
    userId,
    isIdentityLoading,
    entityKey: mergeDraftKey,
    validate: isMergeDraft,
  });
  // Seed the fields once per identity/destination. The settled gate already
  // unmounts the form on an identity/entity change, so re-seeding here (and
  // resetting to today's defaults when there is no draft) keeps a reused
  // instance from showing or saving the previous account's or PR's text.
  const draftSeedKeyRef = useRef<string | null>(null);
  const draftSeedKey = `${userId ?? 'anonymous'}\u0000${mergeDraftKey}`;
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
  // The parts file writes `.current` in its onChangeText handlers; the proxies
  // hook those writes into the debounced save.
  const titleSaveRef = useMemo(() => savingRef(titleRef, saveMergeDraft), [saveMergeDraft]);
  const messageSaveRef = useMemo(() => savingRef(messageRef, saveMergeDraft), [saveMergeDraft]);
  useDraftFlushOnBackground(userId, mergeDraftKey, true);

  // Half detent (~0.5) vs full: hide delete-branch + tighten message so
  // Merge/Cancel stay above the closed-sheet limit without scrolling.
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
  const isHalfDetent = scrollViewportHeight > 0 && scrollViewportHeight < windowHeight * 0.65;

  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'non-retryable' | 'reconnect' | null
  >(null);

  const ref: { owner: string; repo: string; number: number } = useMemo(
    () => ({ owner, repo: repoName, number }),
    [owner, repoName, number]
  );

  const mergeMutation = useMergePullRequestMutation(ref);
  const enableAutoMergeMutation = useEnableAutoMergeMutation(ref);

  const isMutating =
    (mode === 'merge' && mergeMutation.isPending) ||
    (mode === 'enable-auto-merge' && enableAutoMergeMutation.isPending);
  const lastError = mode === 'merge' ? mergeMutation.error : enableAutoMergeMutation.error;

  useEffect(() => {
    if (lastError) {
      // The ledger persistence-failure marker is retry-blocking: the row never
      // became `reconcile_pending`, so the same key must not be retried.
      if (isPrOperationPersistenceFailed(lastError)) {
        setInlineError(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
        setInlineErrorKind('non-retryable');
        return;
      }
      const classification = classifyPrReviewMutationError(lastError);
      if (classification.kind === 'bad-request' || classification.kind === 'forbidden') {
        setInlineError(
          classification.kind === 'forbidden'
            ? "You don't have permission to merge this pull request."
            : 'This pull request cannot be merged as is.'
        );
        setInlineErrorKind('non-retryable');
      } else if (classification.kind === 'reconnect') {
        setInlineError('GitHub connection expired.');
        setInlineErrorKind('reconnect');
      } else {
        setInlineError(
          lastError instanceof Error ? lastError.message : 'Could not merge pull request.'
        );
        setInlineErrorKind('retryable');
      }
    }
  }, [lastError]);

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
    });
    return () => {
      sub.remove();
    };
  }, []);

  function resetForNewMethod(next: AllowedMergeMethod) {
    setMethod(next);
  }

  function buildMergeInput(): MergePullRequestInput {
    return {
      owner,
      repo: repoName,
      number,
      method,
      commitTitle: titleRef.current.trim().length > 0 ? titleRef.current.trim() : undefined,
      commitMessage: messageRef.current.trim().length > 0 ? messageRef.current.trim() : undefined,
      deleteBranch: showDeleteBranchToggle ? deleteBranch : false,
      expectedHeadSha: headSha,
    };
  }

  function buildAutoMergeInput(): AutoMergeInput {
    const autoMethod: 'MERGE' | 'SQUASH' | 'REBASE' = (() => {
      if (method === 'merge') {
        return 'MERGE';
      }
      if (method === 'squash') {
        return 'SQUASH';
      }
      return 'REBASE';
    })();
    return {
      owner,
      repo: repoName,
      number,
      prNodeId,
      method: autoMethod,
      commitTitle: titleRef.current.trim().length > 0 ? titleRef.current.trim() : undefined,
      commitMessage: messageRef.current.trim().length > 0 ? messageRef.current.trim() : undefined,
    };
  }

  async function performSubmit() {
    setInlineError(null);
    setInlineErrorKind(null);
    try {
      let celebrate = false;
      // eslint-disable-next-line typescript-eslint/prefer-ternary -- awaits inside branches can't be a ternary expression
      if (mode === 'merge') {
        // P0-B-08: only resolved here when `merged: true` (the hook's
        // `assertMergeResult` throws on `merged: false` so a "not
        // mergeable" reply is treated as a retryable mutation error,
        // NOT a success). The pure helper decides whether the post-merge
        // step (branch delete) is a partial success that needs a
        // persistent banner on the PR review screen, then the sheet
        // celebrates in BOTH clean and partial cases. The `incomplete`
        // gate never reaches here because `mutateAsync` would have
        // rejected.
        const result = await mergeMutation.mutateAsync(buildMergeInput());
        ({ celebrate } = applyMergeSuccessEffects(result, ref));
      } else {
        await enableAutoMergeMutation.mutateAsync(buildAutoMergeInput());
        celebrate = true;
      }
      if (celebrate) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await onRefetch();
        // The merge consumed the draft; clear it before dismissing so it never
        // reappears on the next visit.
        if (userId) {
          void clearDraft(userId, mergeDraftKey);
        }
        // Dismiss exactly this merge route; `onDismiss` (router.back) leaves the
        // refreshed PR review screen visible. Do NOT also call router.back()
        // here or it would pop the review screen too.
        onDismiss();
      }
    } catch {
      // The effect above classifies the mutation error into inlineError;
      // swallow here to avoid an unhandled promise rejection.
    }
  }

  function handleConfirmPress() {
    if (isMutating || noMethodsAllowed) {
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);

    const submit = () => {
      void performSubmit();
    };

    if (mode === 'merge') {
      Alert.alert('Merge pull request?', 'This will merge your changes into the base branch.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Merge', style: 'destructive', onPress: submit },
      ]);
      return;
    }
    Alert.alert(
      'Enable auto-merge?',
      'GitHub will merge this pull request automatically when all required checks pass.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Enable auto-merge', style: 'destructive', onPress: submit },
      ]
    );
  }

  const submitLabel = mode === 'merge' ? 'Merge' : 'Enable auto-merge';
  // A repository can (rarely) have every merge method disabled. GitHub would
  // reject any submission, so surface it explicitly and block the action
  // rather than sending a method the repo does not allow.
  const noMethodsAllowed = methodOptions.length === 0;

  // The footer Cancel is an explicit discard: clear the draft and leave. The
  // header back (onBack) is a passive dismiss that keeps the draft.
  function handleCancel() {
    if (userId) {
      void clearDraft(userId, mergeDraftKey);
    }
    onDismiss();
  }

  // PickerSheet invariant: [header, ScrollView]; footer is trailing content.
  return (
    <>
      <PrFormSheetHeader title={sheetTitle} eyebrow={eyebrow} onBack={onDismiss} />
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-background"
        contentContainerClassName="pb-1"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        onLayout={event => {
          setScrollViewportHeight(event.nativeEvent.layout.height);
        }}
      >
        {draft.settled ? (
          <MergeSheetFormBody
            noMethodsAllowed={noMethodsAllowed}
            methodOptions={methodOptions}
            method={method}
            isMutating={isMutating}
            onMethodChange={resetForNewMethod}
            titleRef={titleSaveRef}
            titleInputRef={titleInputRef}
            titlePlaceholder={defaultCommitTitle(title, number)}
            messageRef={messageSaveRef}
            messageInputRef={messageInputRef}
            isHalfDetent={isHalfDetent}
            showDeleteBranchToggle={showDeleteBranchToggle}
            deleteBranch={deleteBranch}
            onDeleteBranchChange={setDeleteBranch}
            inlineError={inlineError}
            inlineErrorKind={inlineErrorKind}
            submitLabel={submitLabel}
            onConfirm={handleConfirmPress}
            onDismiss={handleCancel}
          />
        ) : null}
      </ScrollView>
    </>
  );
}
