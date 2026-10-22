import {
  Keyboard,
  ScrollView,
  type ScrollViewInstance,
  type TextInput,
  useWindowDimensions,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type ProviderPrMergeState,
  type ProviderReviewCapability,
} from '@kilocode/app-shared/provider-review';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import {
  type AllowedMergeMethod,
  type PrMergeMethod,
  type PrOverviewRepoSettings,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import {
  defaultMergeMethodOptionFor,
  mergeMethodOptionsFor,
} from '@/components/pr-review/merge/pr-merge-icons';
import { MergeSheetFormBody } from '@/components/pr-review/merge/pr-merge-sheet-parts';
import { PrMergeProviderBody } from '@/components/pr-review/merge/pr-merge-provider-body';
import { usePrMergeDraft } from '@/components/pr-review/merge/use-pr-merge-draft';
import { usePrMergeSubmit } from '@/components/pr-review/merge/use-pr-merge-submit';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { defaultCommitTitle } from '@/lib/pr-review/merge/merge-commit-defaults';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';

// flexGrow makes the ScrollView's content container at least the viewport
// tall, so a short arm's spacer can push its footer to the sheet's bottom.
const SHEET_SCROLL_CONTENT_STYLE = { flexGrow: 1, paddingBottom: 4 };

type PrMergeSheetProps = Readonly<{
  owner: string;
  repoName: string;
  number: number;
  headSha: string;
  isCrossRepo: boolean;
  prNodeId: string;
  title: string;
  bodyMarkdown: string | null;
  repo: PrOverviewRepoSettings;
  initialMethod: PrMergeMethod;
  mode: 'merge' | 'enable-auto-merge';
  sheetTitle: string;
  eyebrow: string;
  prRef?: ProviderPrRef;
  mergeState?: ProviderPrMergeState | null;
  autoMergeCapability?: ProviderReviewCapability;
  onRefetch: () => Promise<void>;
  onDismiss: () => void;
}>;

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
  // Labels resolve through module i18n; rebuild so an open sheet follows language changes.
  const providerMethodOptions = prRef
    ? mergeMethodOptionsFor({
        ...repoSettings,
        allowMergeCommit: true,
        allowSquashMerge: prRef.platform === 'gitlab',
        allowRebaseMerge: false,
        allowAutoMerge: prRef.platform === 'gitlab',
      })
    : null;
  const methodOptions = providerMethodOptions ?? mergeMethodOptionsFor(repoSettings);
  const [method, setMethod] = useState<AllowedMergeMethod>(
    () =>
      methodOptions.find(o => o.value === initialMethod)?.value ??
      (providerMethodOptions
        ? (providerMethodOptions[0]?.value ?? defaultMergeMethodOptionFor(repoSettings))
        : defaultMergeMethodOptionFor(repoSettings))
  );
  const showDeleteBranchToggle = prRef ? true : !isCrossRepo;
  const [deleteBranch, setDeleteBranch] = useState<boolean>(repoSettings.deleteBranchOnMerge);
  const titleInputRef = useRef<TextInput>(null);
  const messageInputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const { height: windowHeight } = useWindowDimensions();
  const { settled, titleRef, messageRef, titleSaveRef, messageSaveRef, clearMergeDraft } =
    usePrMergeDraft({ owner, repoName, number, title, bodyMarkdown, prRef });

  // Half detent (~0.5) vs full: hide delete-branch + tighten message so
  // Merge/Cancel stay above the closed-sheet limit without scrolling.
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
  const isHalfDetent = scrollViewportHeight > 0 && scrollViewportHeight < windowHeight * 0.65;
  const noMethodsAllowed = methodOptions.length === 0;
  const { isMutating, inlineError, inlineErrorKind, handleConfirmPress, dialog } = usePrMergeSubmit(
    {
      owner,
      repoName,
      number,
      headSha,
      prNodeId,
      mode,
      prRef,
      method,
      noMethodsAllowed,
      showDeleteBranchToggle,
      deleteBranch,
      titleRef,
      messageRef,
      clearMergeDraft,
      onRefetch,
      onDismiss,
    }
  );

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

  // Footer Cancel discards; header back passively dismisses and retains the draft.
  function handleCancel() {
    clearMergeDraft();
    onDismiss();
  }

  return (
    <>
      <PrFormSheetHeader title={sheetTitle} eyebrow={eyebrow} onBack={onDismiss} />
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-background"
        contentContainerStyle={SHEET_SCROLL_CONTENT_STYLE}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        onLayout={event => {
          setScrollViewportHeight(event.nativeEvent.layout.height);
        }}
      >
        {settled ? (
          <PrMergeProviderBody
            providerAutoMerge={Boolean(prRef) && mode === 'enable-auto-merge'}
            autoMergeCapability={autoMergeCapability}
            mergeState={mergeState}
            term={prRef ? t(providerPrNounKey(prRef.platform)) : ''}
            isMutating={isMutating}
            onConfirm={handleConfirmPress}
            onCancel={handleCancel}
          >
            <MergeSheetFormBody
              noMethodsAllowed={noMethodsAllowed}
              methodOptions={methodOptions}
              method={method}
              isMutating={isMutating}
              onMethodChange={setMethod}
              titleRef={titleSaveRef}
              titleInputRef={titleInputRef}
              titlePlaceholder={defaultCommitTitle(title, number)}
              showTitle={prRef?.platform !== 'bitbucket'}
              messageRef={messageSaveRef}
              messageInputRef={messageInputRef}
              isHalfDetent={isHalfDetent}
              showDeleteBranchToggle={showDeleteBranchToggle}
              deleteBranch={deleteBranch}
              onDeleteBranchChange={setDeleteBranch}
              inlineError={inlineError}
              inlineErrorKind={inlineErrorKind}
              submitLabel={
                mode === 'merge' ? t('prReview.merge.merge') : t('prReview.merge.enableAutoMerge')
              }
              onConfirm={handleConfirmPress}
              onDismiss={handleCancel}
            />
          </PrMergeProviderBody>
        ) : null}
      </ScrollView>
      {dialog}
    </>
  );
}
