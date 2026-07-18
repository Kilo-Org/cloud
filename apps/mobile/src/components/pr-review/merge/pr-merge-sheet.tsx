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
import { Alert, ScrollView, type TextInput, View } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type AllowedMergeMethod,
  type PrMergeMethod,
  type PrOverviewRepoSettings,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import {
  useEnableAutoMergeMutation,
  useMergePullRequestMutation,
} from '@/lib/pr-review/merge/use-pr-merge-mutations';
import {
  defaultMergeMethodOptionFor,
  mergeMethodOptionsFor,
} from '@/components/pr-review/merge/pr-merge-icons';
import {
  CommitMessageField,
  CommitTitleField,
  DeleteBranchToggle,
  MethodPicker,
} from '@/components/pr-review/merge/pr-merge-sheet-parts';

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
  headRef: string;
  isCrossRepo: boolean;
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

function defaultCommitTitle(title: string, number: number): string {
  return `${title} (#${number})`;
}

function defaultCommitMessage(method: PrMergeMethod, body: string | null): string {
  if (method === 'squash') {
    return body && body.trim().length > 0 ? body : '';
  }
  if (body && body.trim().length > 0) {
    return body;
  }
  return '';
}

export function PrMergeSheet(props: PrMergeSheetProps) {
  const {
    owner,
    repoName,
    number,
    headSha,
    headRef,
    isCrossRepo,
    prNodeId,
    title,
    bodyMarkdown,
    repo: repoSettings,
    initialMethod,
    mode,
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
  const titleRef = useRef(defaultCommitTitle(title, number));
  const messageRef = useRef(defaultCommitMessage(safeInitial, bodyMarkdown));

  const [inlineError, setInlineError] = useState<string | null>(null);

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
      const message =
        lastError instanceof Error ? lastError.message : 'Could not merge pull request.';
      setInlineError(message);
    }
  }, [lastError]);

  function resetForNewMethod(next: AllowedMergeMethod) {
    setMethod(next);
    messageRef.current = defaultCommitMessage(next, bodyMarkdown);
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
      headRef,
      isCrossRepo,
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
    try {
      // eslint-disable-next-line typescript-eslint/prefer-ternary -- awaits inside branches can't be a ternary expression
      if (mode === 'merge') {
        await mergeMutation.mutateAsync(buildMergeInput());
      } else {
        await enableAutoMergeMutation.mutateAsync(buildAutoMergeInput());
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await onRefetch();
      // Dismiss exactly this merge route; `onDismiss` (router.back) leaves the
      // refreshed PR review screen visible. Do NOT also call router.back()
      // here or it would pop the review screen too.
      onDismiss();
    } catch (error) {
      if (error instanceof Error && error.message) {
        setInlineError(error.message);
      } else {
        setInlineError('Could not merge pull request.');
      }
    }
  }

  function handleConfirmPress() {
    if (isMutating || noMethodsAllowed) {
      return;
    }
    setInlineError(null);

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

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-6 pb-10 pt-2"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
      >
        {noMethodsAllowed ? (
          <View className="rounded-md border border-border bg-secondary p-3">
            <Text className="text-sm text-muted-foreground">
              This repository has no enabled merge methods. Ask a repository admin to enable merge,
              squash, or rebase merging.
            </Text>
          </View>
        ) : (
          <MethodPicker
            methodOptions={methodOptions}
            method={method}
            isDisabled={isMutating}
            onChange={resetForNewMethod}
          />
        )}
        <CommitTitleField
          titleRef={titleRef}
          inputRef={titleInputRef}
          placeholder={defaultCommitTitle(title, number)}
          isDisabled={isMutating}
        />
        {/* Remount on method change so the visible commit message matches the
            method-specific default that will actually be submitted. */}
        <CommitMessageField
          key={method}
          messageRef={messageRef}
          inputRef={messageInputRef}
          isDisabled={isMutating}
        />
        {showDeleteBranchToggle ? (
          <DeleteBranchToggle
            value={deleteBranch}
            onChange={setDeleteBranch}
            isDisabled={isMutating}
          />
        ) : null}
        {inlineError ? (
          <View
            className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 p-3"
            accessibilityLiveRegion="polite"
          >
            <Text className="text-sm text-destructive">{inlineError}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View className="border-t-[0.5px] border-hair-soft bg-background px-6 pb-6 pt-3">
        <Button
          onPress={handleConfirmPress}
          loading={isMutating}
          disabled={noMethodsAllowed}
          accessibilityLabel={submitLabel}
        >
          <Text>{submitLabel}</Text>
        </Button>
        <Button
          variant="ghost"
          onPress={onDismiss}
          disabled={isMutating}
          className="mt-2"
          accessibilityLabel="Cancel"
        >
          <Text>Cancel</Text>
        </Button>
      </View>
    </View>
  );
}
