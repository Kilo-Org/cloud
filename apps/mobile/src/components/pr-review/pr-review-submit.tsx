// Review-submit content: event radio, optional summary, pending-comments
// list (view/edit/delete), and one batched submitReview call. Queue is
// cleared on success and retained on failure.
//
// Disable lifetime: bad-request clears on event/summary change; forbidden
// stays for the rest of the sheet session. Toasts paint behind formSheets
// on iOS, so the mutation hook toasts onError AND the sheet shows inline.

import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, type TextInput, View } from 'react-native';

import {
  PrFormSheetFooter,
  PrFormSheetHeader,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import { Button } from '@/components/ui/button';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import {
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
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { mutationErrorDisplay } from '@/lib/pr-review/mutation-error-display';
import { type PendingReviewItem, usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useSubmitReviewMutation } from '@/lib/pr-review/use-pr-review-mutations';
import { cn } from '@/lib/utils';

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

const EVENT_OPTIONS: readonly { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
  { value: 'APPROVE', label: 'Approve' },
];

export function PrReviewSubmit(props: PrReviewSubmitProps) {
  const { owner, repo, number, headSha, title, eyebrow, onDismiss } = props;
  const router = useRouter();
  const pending = usePendingReview();
  const submitReview = useSubmitReviewMutation({ owner, repo, number });

  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [hasSummary, setHasSummary] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);

  const bodyRef = useRef<string>('');
  const bodyInputRef = useRef<TextInput | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const isSubmitting = submitReview.isPending;
  const queuedCount = pending.items.length;
  const hasStaleItems = pending.items.some(item => item.commitSha !== headSha);
  const blockReason = reviewSubmitBlockReason({
    event,
    hasSummary,
    commentCount: queuedCount,
  });

  useEffect(() => {
    if (submitReview.error) {
      const classification = classifyPrReviewMutationError(submitReview.error);
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
          items: pending.items,
        })
      );
      pending.clear();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDismiss();
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
    Alert.alert('Delete pending comment?', 'This comment will be removed from the review queue.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          pending.removeComment(item.id);
        },
      },
    ]);
  }

  const submitDisabled =
    isSubmitting ||
    blockReason !== null ||
    inlineErrorKind === 'bad-request' ||
    inlineErrorKind === 'forbidden' ||
    inlineErrorKind === 'reconnect';

  const keyboardVisible = useFormSheetKeyboardVisible();
  // Keyboard-open viewport is tight; keep count, hide per-item rows so
  // Submit + Cancel stay above the keyboard at scroll offset 0.
  const showPendingRows = !keyboardVisible;

  // Hint only when empty/stale — skips the long happy-path line that
  // pushed footer CTAs below half-detent. blockReason replaces
  // PendingQueueHint so empty-queue + COMMENT is not contradictory.
  // blockReason is a local persistent validation error (no mutation toast
  // owns it), so AccessibleStatus announces it through the status contract.
  let queueHint: ReactNode = null;
  if (blockReason !== null) {
    queueHint = <AccessibleStatus message={blockReason} tone="status" className="text-xs" />;
  } else if (!keyboardVisible && (queuedCount === 0 || hasStaleItems)) {
    queueHint = <PendingQueueHint queuedCount={queuedCount} hasStaleItems={hasStaleItems} />;
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
        <View className="gap-2 px-6 pt-2">
          <ReviewEventChips
            value={event}
            disabled={isSubmitting}
            onChange={next => {
              setEvent(next);
              clearRecoverableError();
            }}
          />
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Summary (optional)</Text>
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
              {queuedCount} pending {queuedCount === 1 ? 'comment' : 'comments'}
            </Text>
            {queueHint}
            {showPendingRows
              ? pending.items.map(item => (
                  <PrReviewPendingCommentRow
                    key={item.id}
                    item={item}
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
            accessibilityLabel="Submit review"
          >
            <Text>Submit review</Text>
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              if (!isSubmitting) {
                onDismiss();
              }
            }}
            disabled={isSubmitting}
            className="mt-1"
            accessibilityLabel="Cancel"
          >
            <Text>Cancel</Text>
          </Button>
        </PrFormSheetFooter>
      </ScrollView>
    </>
  );
}

/** Horizontal event chips — vertical PillGroup is too tall for half-detent. */
function ReviewEventChips(props: {
  value: ReviewEvent;
  disabled: boolean;
  onChange: (next: ReviewEvent) => void;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Review event
      </Text>
      <RadioGroup label="Review event" className="flex-row flex-wrap gap-1.5">
        {EVENT_OPTIONS.map(option => {
          const active = props.value === option.value;
          return (
            <Pressable
              key={option.value}
              disabled={props.disabled}
              onPress={() => {
                void Haptics.selectionAsync();
                props.onChange(option.value);
              }}
              {...radioItemA11y({ label: option.label, checked: active, disabled: props.disabled })}
              className={cn(
                'min-h-9 items-center justify-center rounded-full border px-3 py-1.5 active:opacity-70',
                active && 'border-primary bg-primary',
                !active && props.disabled && 'border-hair-soft bg-secondary',
                !active && !props.disabled && 'border-border bg-secondary'
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  active && 'text-primary-foreground',
                  !active && props.disabled && 'text-muted-foreground',
                  !active && !props.disabled && 'text-foreground'
                )}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </RadioGroup>
    </View>
  );
}
