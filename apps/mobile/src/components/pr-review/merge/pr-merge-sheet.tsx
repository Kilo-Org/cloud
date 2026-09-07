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
import {
  Alert,
  Keyboard,
  ScrollView,
  type TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type ProviderPrMergeBlockedReason,
  type ProviderPrMergeState,
  type ProviderPrPlatform,
  type ProviderReviewCapability,
} from '@kilocode/app-shared/provider-review';

import { PrFormSheetFooter, PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { PrReviewCapabilityBanner } from '@/components/pr-review/pr-review-capability-banner';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type AllowedMergeMethod,
  type PrMergeMethod,
  type PrOverviewRepoSettings,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import {
  type EnableAutoMergeVars,
  type MergeVars,
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
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import {
  defaultCommitMessage,
  defaultCommitTitle,
} from '@/lib/pr-review/merge/merge-commit-defaults';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { formatNumber } from '@/lib/format';
import { i18n } from '@/i18n';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import { readTrpcErrorField } from '@/lib/trpc-error';
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
  /**
   * The provider ref (s6). Present on the GitLab/Bitbucket surface: the merge
   * posts through `providerReview.mergePullRequest` with the head fence, the
   * method list comes from the provider (not the GitHub repo settings), and
   * the draft key folds the ref identity. Absent on GitHub, which keeps the
   * exact pre-s6 path.
   */
  prRef?: ProviderPrRef;
  /**
   * The provider merge gate from `providerReview.getMergeState` (s2/s3).
   * Rendered as the restrictions list and gates the submit; null on GitHub,
   * whose gate derives from the overview DTO in the merge section.
   */
  mergeState?: ProviderPrMergeState | null;
  /**
   * The auto-merge capability (provider arms). A `supported: false` answer
   * (Bitbucket) renders the explicit capability banner instead of the form.
   */
  autoMergeCapability?: ProviderReviewCapability;
  /** Called after a successful merge / auto-merge enable so the orchestrator can refetch. */
  onRefetch: () => Promise<void>;
  /** Called when the user cancels or after a successful submit. */
  onDismiss: () => void;
}>;

/**
 * The provider's own noun in sentence form (s6). Defined in
 * `pr-review-provider-noun.ts` (shared with the overview's provider merge
 * arm) and re-exported here for the sheet's callers.
 */
export { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';

/**
 * The explicit stale-head rejection (s6): the server refuses a merge whose
 * head moved (or whose target closed) with CONFLICT carrying the provider's
 * own reason. There is nothing to retry against the old head, so the sheet
 * keeps that reason inline and stays put — no redirect, no retry affordance.
 * Returns the reason to show, or null when the error is not a stale-head.
 */
export function staleHeadRejectionMessage(error: unknown): string | null {
  if (readTrpcErrorField(error, 'code') !== 'CONFLICT') {
    return null;
  }
  const message = error instanceof Error ? error.message : '';
  return /changed since it was loaded|closed without merging/.test(message) ? message : null;
}

/**
 * The inline copy for a refused merge (s6f): the provider arm words the
 * refusal after the connected provider (merge request vs pull request)
 * through the existing term-parameterized key; GitHub keeps the exact
 * pre-s6 copy.
 */
function mergeForbiddenCopy(
  platform: ProviderPrPlatform | undefined,
  t: ReturnType<typeof useTranslation>['t']
): string {
  return platform
    ? t('prReview.merge.providerBlocked.permission', { term: t(providerPrNounKey(platform)) })
    : t('prReview.merge.forbidden');
}

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
    prRef,
    mergeState,
    autoMergeCapability,
    onRefetch,
    onDismiss,
  } = props;

  const { t } = useTranslation();

  // Provider arms derive the method list from the platform, not the GitHub
  // repo settings: GitLab offers merge + squash, Bitbucket Cloud only the
  // merge commit. GitHub keeps the repo-settings list unchanged.
  const providerMethodOptions = useMemo(() => {
    if (!prRef) {
      return null;
    }
    return mergeMethodOptionsFor({
      ...repoSettings,
      allowMergeCommit: true,
      allowSquashMerge: prRef.platform === 'gitlab',
      allowRebaseMerge: false,
      allowAutoMerge: prRef.platform === 'gitlab',
    });
  }, [prRef, repoSettings]);
  const methodOptions = useMemo(
    () => providerMethodOptions ?? mergeMethodOptionsFor(repoSettings),
    [providerMethodOptions, repoSettings]
  );
  const safeInitial: AllowedMergeMethod = useMemo(
    () =>
      methodOptions.find(o => o.value === initialMethod)?.value ??
      (providerMethodOptions
        ? (providerMethodOptions[0]?.value ?? defaultMergeMethodOptionFor(repoSettings))
        : defaultMergeMethodOptionFor(repoSettings)),
    [initialMethod, methodOptions, providerMethodOptions, repoSettings]
  );
  const [method, setMethod] = useState<AllowedMergeMethod>(safeInitial);

  const showDeleteBranchToggle = prRef ? true : !isCrossRepo;
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
  const positionDraftKey = prMergeDraftKey(owner, repoName, number);
  // Provider arms fold the collision-free ref identity into the key (identity
  // rule 17); the GitHub bytes stay exactly as stored before this slice.
  const mergeDraftKey = prRef ? `${positionDraftKey}@${providerPrRefKey(prRef)}` : positionDraftKey;
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

  const mergeMutation = useMergePullRequestMutation(prRef ?? ref);
  const enableAutoMergeMutation = useEnableAutoMergeMutation(prRef ?? ref);

  const isMutating =
    (mode === 'merge' && mergeMutation.isPending) ||
    (mode === 'enable-auto-merge' && enableAutoMergeMutation.isPending);
  const lastError = mode === 'merge' ? mergeMutation.error : enableAutoMergeMutation.error;
  // The provider platform as a stable primitive: the error effect words a
  // refusal after it without depending on the `prRef` object identity.
  const providerPlatform = prRef?.platform;

  useEffect(() => {
    if (lastError) {
      // The ledger persistence-failure marker is retry-blocking: the row never
      // became `reconcile_pending`, so the same key must not be retried.
      if (isPrOperationPersistenceFailed(lastError)) {
        setInlineError(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
        setInlineErrorKind('non-retryable');
        return;
      }
      // A moved head is the explicit stale-head rejection (s6): the server
      // answers CONFLICT with the provider's own reason, there is nothing to
      // retry against the old head, and the sheet stays put showing it.
      const staleHead = staleHeadRejectionMessage(lastError);
      if (staleHead !== null) {
        setInlineError(staleHead);
        setInlineErrorKind('non-retryable');
        return;
      }
      const classification = classifyPrReviewMutationError(lastError);
      if (classification.kind === 'bad-request' || classification.kind === 'forbidden') {
        setInlineError(
          classification.kind === 'forbidden'
            ? mergeForbiddenCopy(providerPlatform, t)
            : t('prReview.merge.cannotMerge')
        );
        setInlineErrorKind('non-retryable');
      } else if (classification.kind === 'reconnect') {
        setInlineError(t('prReview.connectionExpired'));
        setInlineErrorKind('reconnect');
      } else {
        setInlineError(
          lastError instanceof Error ? lastError.message : t('prReview.merge.couldNotMerge')
        );
        setInlineErrorKind('retryable');
      }
    }
  }, [lastError, t, providerPlatform]);

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

  function buildMergeInput(): MergeVars {
    if (prRef) {
      // The provider merge carries the head fence (the server refuses a moved
      // head before any merge call); GitLab folds the method into `squash`
      // and takes a commit title, Bitbucket only the message — and the form
      // hides the title input on that arm (s6f), so no typed value is ever
      // dropped. The term rides the fingerprint so a retried intent re-merges
      // the same revision.
      const commitMessage = messageRef.current.trim();
      return {
        expectedHeadSha: headSha,
        ...(prRef.platform === 'gitlab'
          ? {
              squash: method === 'squash',
              ...(titleRef.current.trim().length > 0
                ? { commitTitle: titleRef.current.trim() }
                : {}),
            }
          : {}),
        deleteBranch: showDeleteBranchToggle ? deleteBranch : false,
        ...(commitMessage.length > 0 ? { commitMessage } : {}),
      };
    }
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

  function buildAutoMergeInput(): EnableAutoMergeVars {
    if (prRef) {
      // GitLab arms merge-when-pipeline-succeeds fenced on the head; the
      // method rides the server-side squash handling. Bitbucket never gets
      // here: the capability banner replaces the form.
      return { expectedHeadSha: headSha };
    }
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

    // Provider arms word the nouns after the connected provider (merge
    // request vs pull request); GitHub keeps its exact pre-s6 copy.
    if (mode === 'merge') {
      const [confirmTitle, confirmMessage] = prRef
        ? [
            t('prReview.merge.confirmTitleTerm', { term: t(providerPrNounKey(prRef.platform)) }),
            t('prReview.merge.confirmMessage'),
          ]
        : [t('prReview.merge.confirmTitle'), t('prReview.merge.confirmMessage')];
      Alert.alert(confirmTitle, confirmMessage, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('prReview.merge.merge'), style: 'destructive', onPress: submit },
      ]);
      return;
    }
    Alert.alert(
      t('prReview.merge.enableAutoMergeConfirmTitle'),
      prRef
        ? t('prReview.merge.enableAutoMergeConfirmMessageTerm', {
            term: t(providerPrNounKey(prRef.platform)),
          })
        : t('prReview.merge.enableAutoMergeConfirmMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('prReview.merge.enableAutoMerge'), style: 'destructive', onPress: submit },
      ]
    );
  }

  const submitLabel =
    mode === 'merge' ? t('prReview.merge.merge') : t('prReview.merge.enableAutoMerge');
  // Provider arms (s6): the provider's own noun for the confirm copy, and the
  // two auto-merge shapes — GitLab arms through the seam, Bitbucket Cloud has
  // no auto-merge API and opens onto the capability banner instead.
  const providerTerm = prRef ? t(providerPrNounKey(prRef.platform)) : '';
  const providerAutoMerge = Boolean(prRef) && mode === 'enable-auto-merge';
  const autoMergeUnsupported = providerAutoMerge && autoMergeCapability?.supported === false;
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

  // The body a settled draft renders: the arm the provider state selects —
  // the Bitbucket auto-merge capability banner, the GitLab auto-merge body,
  // a blocked merge state's restrictions, or the form. The cancel-only
  // arms share the ghost footer button.
  function cancelOnlyFooter() {
    return (
      <PrFormSheetFooter>
        <Button
          variant="ghost"
          onPress={handleCancel}
          disabled={isMutating}
          className="mt-2"
          accessibilityLabel={t('common.cancel')}
        >
          <Text>{t('common.cancel')}</Text>
        </Button>
      </PrFormSheetFooter>
    );
  }

  const settledBody = ((): ReactNode => {
    if (autoMergeUnsupported) {
      // A Bitbucket auto-merge opens onto the capability banner: the provider
      // has no API to arm, so there is nothing to submit or retry.
      return (
        <>
          <View className="gap-4 px-6 pt-4">
            <PrReviewCapabilityBanner capability={autoMergeCapability} />
          </View>
          {cancelOnlyFooter()}
        </>
      );
    }
    if (providerAutoMerge) {
      return (
        <>
          <ProviderAutoMergeBody mergeState={mergeState} term={providerTerm} />
          <PrFormSheetFooter>
            <Button
              onPress={handleConfirmPress}
              loading={isMutating}
              disabled={isMutating}
              accessibilityLabel={t('prReview.merge.enableAutoMerge')}
            >
              <Text>{t('prReview.merge.enableAutoMerge')}</Text>
            </Button>
            <Button
              variant="ghost"
              onPress={handleCancel}
              disabled={isMutating}
              className="mt-2"
              accessibilityLabel={t('common.cancel')}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
          </PrFormSheetFooter>
        </>
      );
    }
    if (mergeState && !mergeState.canMerge) {
      // A blocked merge state replaces the form with the restrictions list
      // (nothing to submit).
      return (
        <>
          <View className="gap-4 px-6 pt-4">
            <MergeRestrictionsList mergeState={mergeState} term={providerTerm} />
          </View>
          {cancelOnlyFooter()}
        </>
      );
    }
    return (
      <>
        {mergeState ? (
          <View className="px-6 pt-4">
            <MergeRestrictionsList mergeState={mergeState} term={providerTerm} />
          </View>
        ) : null}
        <MergeSheetFormBody
          noMethodsAllowed={noMethodsAllowed}
          methodOptions={methodOptions}
          method={method}
          isMutating={isMutating}
          onMethodChange={resetForNewMethod}
          titleRef={titleSaveRef}
          titleInputRef={titleInputRef}
          titlePlaceholder={defaultCommitTitle(title, number)}
          // Bitbucket Cloud's merge API takes only the message: no title
          // input exists on that arm whose value would be dropped on submit.
          showTitle={prRef?.platform !== 'bitbucket'}
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
      </>
    );
  })();

  // PickerSheet invariant: [header, ScrollView]; footer is trailing content.
  // Provider arms (s6): the s2/s3 merge state renders as the restrictions
  // list; a blocked state replaces the form with that list (nothing to
  // submit), and a Bitbucket auto-merge opens onto the capability banner.
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
        {draft.settled ? settledBody : null}
      </ScrollView>
    </>
  );
}

/** The localized copy for one provider blocked reason; `other` keeps the server's message. */
function providerBlockedReasonText(
  reason: ProviderPrMergeBlockedReason,
  term: string,
  t: ReturnType<typeof useTranslation>['t']
): string {
  // Literal keys, never a template: the catalog check scans the source for
  // the keys a lookup passes on, and a computed key is invisible to it.
  const KEY_BY_CODE = {
    conflicts: 'prReview.merge.blocked.conflictsDetail',
    required_approvals: 'prReview.merge.blocked.requiredReviewsDetail',
    failing_pipeline: 'prReview.merge.providerBlocked.failingPipeline',
    pending_pipeline: 'prReview.merge.providerBlocked.pendingPipeline',
    draft: 'prReview.merge.providerBlocked.draft',
    permission: 'prReview.merge.providerBlocked.permission',
    other: null,
  } satisfies Record<ProviderPrMergeBlockedReason['code'], string | null>;
  const key = KEY_BY_CODE[reason.code];
  if (key === null) {
    return reason.message;
  }
  return t(key, { term });
}

/**
 * The s2/s3 merge state as an explicit restrictions list (s6): the branch
 * policy flags first, then the provider's concrete blocked reasons. Rows the
 * reasons list already carries are not repeated from the flags.
 */
export function MergeRestrictionsList({
  mergeState,
  term,
}: Readonly<{ mergeState: ProviderPrMergeState; term: string }>) {
  const { t } = useTranslation();
  const hasConflictReason = mergeState.blockedReasons.some(reason => reason.code === 'conflicts');
  const hasApprovalsReason = mergeState.blockedReasons.some(
    reason => reason.code === 'required_approvals'
  );
  const hasPipelineReason = mergeState.blockedReasons.some(
    reason => reason.code === 'failing_pipeline' || reason.code === 'pending_pipeline'
  );
  const rows: { id: string; text: string }[] = [];
  if (mergeState.conflicts && !hasConflictReason) {
    rows.push({ id: 'conflicts', text: t('prReview.merge.blocked.conflictsDetail') });
  }
  if (mergeState.approvalsRequired > 0 && !hasApprovalsReason) {
    rows.push({
      id: 'approvals',
      text: t('prReview.merge.restrictions.approvalsRequired', {
        count: mergeState.approvalsRequired,
        displayCount: formatNumber(mergeState.approvalsRequired, i18n.language),
      }),
    });
  }
  if (mergeState.pipelineMustSucceed && !hasPipelineReason) {
    rows.push({
      id: 'pipeline',
      text: t('prReview.merge.restrictions.pipelineMustSucceed'),
    });
  }
  for (const reason of mergeState.blockedReasons) {
    rows.push({
      id: `blocked:${reason.code}:${reason.message}`,
      text: providerBlockedReasonText(reason, term, t),
    });
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <View className="gap-2 rounded-lg border border-border bg-secondary p-4">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.merge.restrictions.title')}
      </Text>
      {rows.map(row => (
        <Text key={row.id} className="text-xs text-muted-foreground">
          {'• '}
          {row.text}
        </Text>
      ))}
    </View>
  );
}

/**
 * The GitLab auto-merge body (s6): the merge state's restrictions plus one
 * plain explanation. No form fields exist on this arm — arming rides only
 * the head fence.
 */
export function ProviderAutoMergeBody({
  mergeState,
  term,
}: Readonly<{ mergeState: ProviderPrMergeState | null | undefined; term: string }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-4 px-6 pt-4">
      {mergeState ? <MergeRestrictionsList mergeState={mergeState} term={term} /> : null}
      <Text className="text-sm text-muted-foreground">
        {t('prReview.merge.enableAutoMergeDescriptionTerm', { term })}
      </Text>
    </View>
  );
}
