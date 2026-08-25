/* eslint-disable max-lines -- the submit sheet composes the event radio, summary, pending-comments list, and the stale/fresh partition in one cohesive surface. */
// Review-submit content: event radio, optional summary, pending-comments
// list (view/edit/delete), and one batched submitReview call. On success the
// fresh comments are removed and stale comments stay queued; on failure the
// whole queue is retained.
//
// Disable lifetime: bad-request clears on event/summary change; forbidden
// stays for the rest of the sheet session. Toasts paint behind formSheets
// on iOS, so the mutation hook toasts onError AND the sheet shows inline.

import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Keyboard, ScrollView, type TextInput, View } from 'react-native';

import {
  PrFormSheetFooter,
  PrFormSheetHeader,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import { ReviewEventChips } from '@/components/pr-review/review-event-chips';
import { Button } from '@/components/ui/button';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import {
  focusAfterPendingCommentRemoval,
  PendingQueueHint,
  PrReviewPendingCommentRow,
  ReviewSummaryField,
} from '@/components/pr-review/pr-review-pending-comment-row';
import {
  buildSubmitReviewInput,
  type ReviewEvent,
  reviewSubmitBlockReason,
} from '@/lib/pr-review/build-submit-review-input';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { ensureTermsAcceptedOutcome } from '@/components/pr-review/discussion/reply-input';
import { i18n } from '@/i18n';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { mutationErrorDisplay } from '@/lib/pr-review/mutation-error-display';
import { type PendingReviewItem, usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { partitionPendingItems } from '@/lib/pr-review/partition-pending-items';
import { useSubmitReviewMutation } from '@/lib/pr-review/use-pr-review-mutations';
import {
  selectPartialSubmitMessage,
  selectSubmitCtaLabel,
} from '@/components/pr-review/pr-review-submit-view';

const COMMENT_COMPOSER_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/comment-composer' as const;

type PrReviewSubmitProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  title: string;
  eyebrow: string;
  onDismiss: () => void;
}>;

export function PrReviewSubmit(props: PrReviewSubmitProps) {
  const { owner, repo, number, headSha, title, eyebrow, onDismiss } = props;
  const router = useRouter();
  const pending = usePendingReview();
  const { t } = useTranslation();
  const submitReview = useSubmitReviewMutation({ owner, repo, number });

  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [hasSummary, setHasSummary] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);
  const [partialResult, setPartialResult] = useState<string | null>(null);

  const bodyRef = useRef<string>('');
  const bodyInputRef = useRef<TextInput | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const isSubmitting = submitReview.isPending;
  const queuedCount = pending.items.length;
  const { fresh, stale } = partitionPendingItems(pending.items, headSha);
  const staleIds = new Set(stale.map(item => item.id));
  const blockReason = reviewSubmitBlockReason({
    event,
    hasSummary,
    commentCount: fresh.length,
  });
  const submitLabel = selectSubmitCtaLabel({
    freshCount: fresh.length,
    totalCount: pending.items.length,
  });

  useEffect(() => {
    if (submitReview.error) {
      const classification = classifyPrReviewMutationError(submitReview.error);
      if (classification.kind === 'terms-required') {
        void (async () => {
          const outcome = await ensureTermsAcceptedOutcome();
          if (outcome.kind === 'accepted') {
            setInlineError(null);
            setInlineErrorKind(null);
          } else if (outcome.kind === 'outdated') {
            setInlineError(i18n.t('prReview.discussion.termsOutdatedCopy'));
            setInlineErrorKind('bad-request');
          } else if (outcome.kind === 'unknown') {
            setInlineError(i18n.t('prReview.discussion.termsCheckRetryCopy'));
            setInlineErrorKind('retryable');
          } else {
            setInlineError(i18n.t('prReview.discussion.termsAcceptRequired'));
            setInlineErrorKind(null);
          }
        })();
        return;
      }
      const display = mutationErrorDisplay('submit', classification, submitReview.error);
      setInlineError(display.message);
      setInlineErrorKind(display.kind);
    }
  }, [submitReview.error]);

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

  function clearRecoverableError() {
    // bad-request / retryable clear on edit; forbidden stays for the session.
    if (inlineErrorKind === 'bad-request' || inlineErrorKind === 'retryable') {
      setInlineError(null);
      setInlineErrorKind(null);
    }
  }

  async function handleSubmit() {
    setInlineError(null);
    setInlineErrorKind(null);
    setPartialResult(null);
    const outcome = await ensureTermsAcceptedOutcome();
    if (outcome.kind === 'outdated') {
      setInlineError(i18n.t('prReview.discussion.termsOutdatedCopy'));
      setInlineErrorKind('bad-request');
      return;
    }
    if (outcome.kind === 'dismissed') {
      return;
    }
    try {
      const body = bodyRef.current.trim();
      await submitReview.mutateAsync(
        buildSubmitReviewInput({
          owner,
          repo,
          number,
          event,
          ...(body.length > 0 ? { body } : {}),
          commitSha: headSha,
          items: fresh,
        })
      );
      pending.removeComments(fresh.map(item => item.id));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (stale.length > 0) {
        // Stale items stay queued: keep the sheet open and report the partial
        // result instead of dismissing, so the user can edit or delete them.
        setPartialResult(
          selectPartialSubmitMessage({ freshCount: fresh.length, staleCount: stale.length })
        );
      } else {
        onDismiss();
      }
    } catch {
      // Classified into inlineError by the effect above.
    }
  }

  function openEditComposer(item: PendingReviewItem) {
    const href: Href = {
      pathname: COMMENT_COMPOSER_PATH,
      params: {
        owner,
        repo,
        number: String(number),
        path: item.path,
        side: item.side,
        line: String(item.line),
        ...(item.startLine !== undefined ? { startLine: String(item.startLine) } : {}),
        pendingId: item.id,
      },
    };
    router.push(href);
  }

  function confirmDelete(item: PendingReviewItem) {
    Alert.alert(
      t('prReview.submit.deletePendingTitle'),
      t('prReview.submit.deletePendingMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('prReview.submit.delete'),
          style: 'destructive',
          onPress: () => {
            // Announce/focus only when the remove is confirmed synchronous:
            // the provider's removeComment filters by id and returns nothing,
            // so the item must still be queued at delete-confirm time.
            const removed = pending.items.some(queued => queued.id === item.id);
            pending.removeComment(item.id);
            focusAfterPendingCommentRemoval(bodyInputRef, removed);
          },
        },
      ]
    );
  }

  const submitDisabled =
    isSubmitting ||
    blockReason !== null ||
    inlineErrorKind === 'bad-request' ||
    inlineErrorKind === 'forbidden' ||
    inlineErrorKind === 'reconnect';

  const keyboardVisible = useFormSheetKeyboardVisible();

  // Hint only when empty/stale — skips the long happy-path line that
  // pushed footer CTAs below half-detent. blockReason replaces
  // PendingQueueHint so empty-queue + COMMENT is not contradictory.
  // blockReason is a local persistent validation error (no mutation toast
  // owns it), so AccessibleStatus announces it through the status contract.
  let queueHint: ReactNode = null;
  if (blockReason !== null) {
    queueHint = <AccessibleStatus message={blockReason} tone="status" className="text-xs" />;
  } else if (!keyboardVisible && (queuedCount === 0 || stale.length > 0)) {
    queueHint = <PendingQueueHint queuedCount={queuedCount} staleCount={stale.length} />;
  }

  // PickerSheet invariant: [header, ScrollView]; footer is trailing content.
  return (
    <>
      <PrFormSheetHeader title={title} eyebrow={eyebrow} onBack={onDismiss} />
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-background"
        contentContainerClassName="pb-2"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
      >
        <View className="gap-4 px-6 pt-4">
          <ReviewEventChips
            value={event}
            disabled={isSubmitting}
            onChange={next => {
              setEvent(next);
              clearRecoverableError();
            }}
          />
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">
              {t('prReview.submit.summaryOptional')}
            </Text>
            <ReviewSummaryField
              bodyRef={bodyRef}
              inputRef={bodyInputRef}
              isDisabled={isSubmitting}
              onChange={() => {
                setHasSummary(bodyRef.current.trim().length > 0);
                clearRecoverableError();
              }}
            />
          </View>

          <View className="gap-1 rounded-lg border border-hair-soft bg-secondary px-3 py-1.5">
            <Text className="text-sm font-medium text-foreground">
              {queuedCount}{' '}
              {queuedCount === 1
                ? t('prReview.submit.pendingCommentSingular')
                : t('prReview.submit.pendingCommentPlural')}
            </Text>
            {queueHint}
            {/* Keyboard-open viewport is tight; keep the count, hide per-item
                rows so Submit + Cancel stay above the keyboard at offset 0. */}
            {!keyboardVisible
              ? pending.items.map(item => (
                  <PrReviewPendingCommentRow
                    key={item.id}
                    item={item}
                    stale={staleIds.has(item.id)}
                    disabled={isSubmitting}
                    onPress={() => {
                      openEditComposer(item);
                    }}
                    onDelete={() => {
                      confirmDelete(item);
                    }}
                  />
                ))
              : null}
          </View>

          {partialResult ? (
            <AccessibleStatus message={partialResult} tone="status" className="text-xs" />
          ) : null}

          {inlineError && inlineErrorKind !== 'reconnect' ? (
            <View className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 px-2.5 py-2">
              {/* Mutation-classified errors are toast-owned (announcingToast);
                  the inline text stays visual-only so it never double-announces. */}
              <Text className="text-xs text-destructive">{inlineError}</Text>
            </View>
          ) : null}
          {inlineErrorKind === 'reconnect' ? (
            <>
              {/* The persistent reconnect message is a local status, not the
                  toast-owned mutation copy, so AccessibleStatus owns its
                  announcement on both platforms. The notice below keeps the
                  Check connection retry CTA. */}
              <AccessibleStatus message={inlineError} tone="status" className="text-xs" />
              <PrReviewReconnectNotice />
            </>
          ) : null}
        </View>

        <PrFormSheetFooter>
          <Button
            onPress={() => {
              void handleSubmit();
            }}
            loading={isSubmitting}
            disabled={submitDisabled}
            accessibilityLabel={submitLabel}
          >
            <Text>{submitLabel}</Text>
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              if (!isSubmitting) {
                onDismiss();
              }
            }}
            disabled={isSubmitting}
            className="mt-2"
            accessibilityLabel={t('common.cancel')}
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
        </PrFormSheetFooter>
      </ScrollView>
    </>
  );
}
