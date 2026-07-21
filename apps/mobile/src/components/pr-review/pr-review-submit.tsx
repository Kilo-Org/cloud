// S7a review-submit content component. The orchestrator mounts this
// inside the `review-submit.tsx` route (S4b left a thin stub there);
// the route supplies the route-params; this component owns the form
// body, the event radio, and the single batched submit.
//
// The sheet drains the `PendingReviewProvider` queue into ONE
// `submitReview` call (per the S3 contract). The head SHA submitted
// is the LATEST one — the per-item `commitSha` is only used by the
// sheet's "may be outdated" hint. The queue is cleared on success
// and retained on failure so the user can decide what to drop or retry.
//
// Submit failures are classified: 422/BAD_REQUEST validation errors
// (approve-own-PR, stale) are non-retryable and remove the submit
// affordance until the user changes the event or body; everything
// else is retryable and keeps the submit button enabled.
//
// Toasts paint behind formSheets on iOS, so the mutation hook toasts
// `onError` AND the sheet renders an inline error box.

import * as Haptics from 'expo-haptics';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  buildSubmitReviewInput,
  type ReviewEvent,
} from '@/lib/pr-review/build-submit-review-input';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useSubmitReviewMutation } from '@/lib/pr-review/use-pr-review-mutations';
import { cn } from '@/lib/utils';

type PrReviewSubmitProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  /** Current PR head SHA — submitted as `commitSha` for the review. */
  headSha: string;
  /** Invoked after a successful submit or a cancel. */
  onDismiss: () => void;
}>;

const EVENT_OPTIONS: readonly { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
  { value: 'APPROVE', label: 'Approve' },
];

export function PrReviewSubmit(props: PrReviewSubmitProps) {
  const { owner, repo, number, headSha, onDismiss } = props;
  const pending = usePendingReview();
  const submitReview = useSubmitReviewMutation({ owner, repo, number });

  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'non-retryable' | 'reconnect' | null
  >(null);

  // iOS uncontrolled pattern: body lives in a ref, the input's visible
  // value is set via defaultValue once. No `value` + state.
  const bodyRef = useRef<string>('');
  const bodyInputRef = useRef<TextInput | null>(null);

  const isSubmitting = submitReview.isPending;
  const queuedCount = pending.items.length;

  // Flag when any queued item was queued against a different head SHA
  // than the current one. Submission still uses the latest head SHA.
  const hasStaleItems = pending.items.some(item => item.commitSha !== headSha);

  useEffect(() => {
    if (submitReview.error) {
      const classification = classifyPrReviewMutationError(submitReview.error);
      if (classification.kind === 'bad-request' || classification.kind === 'forbidden') {
        setInlineError(
          classification.kind === 'forbidden'
            ? "You don't have permission to submit this review."
            : "This review can't be submitted as is. The PR may have changed, or you can't approve your own pull request."
        );
        setInlineErrorKind('non-retryable');
      } else if (classification.kind === 'reconnect') {
        setInlineError('GitHub connection expired.');
        setInlineErrorKind('reconnect');
      } else {
        setInlineError('Could not submit review. Check your connection and try again.');
        setInlineErrorKind('retryable');
      }
    }
  }, [submitReview.error]);

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
      // The effect above classifies the mutation error into inlineError;
      // swallow here to avoid an unhandled promise rejection.
    }
  }

  function handleCancel() {
    if (isSubmitting) {
      return;
    }
    onDismiss();
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pb-8 pt-2"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
      >
        <PillGroup
          label="Review event"
          options={EVENT_OPTIONS}
          value={event}
          disabled={isSubmitting}
          onChange={next => {
            setEvent(next);
            setInlineError(null);
            setInlineErrorKind(null);
          }}
        />
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">Summary (optional)</Text>
          <ReviewBodyField
            bodyRef={bodyRef}
            inputRef={bodyInputRef}
            isDisabled={isSubmitting}
            onChange={() => {
              setInlineError(null);
              setInlineErrorKind(null);
            }}
          />
        </View>

        <View className="gap-2 rounded-lg border border-hair-soft bg-secondary p-3">
          <Text className="text-sm font-medium text-foreground">
            {queuedCount} pending {queuedCount === 1 ? 'comment' : 'comments'}
          </Text>
          <PendingQueueHint queuedCount={queuedCount} hasStaleItems={hasStaleItems} />
        </View>

        {inlineError && inlineErrorKind !== 'reconnect' ? (
          <View
            className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 p-3"
            accessibilityLiveRegion="polite"
          >
            <Text className="text-sm text-destructive">{inlineError}</Text>
          </View>
        ) : null}
        {inlineErrorKind === 'reconnect' ? <PrReviewReconnectNotice /> : null}
      </ScrollView>

      <View className="border-t-[0.5px] border-hair-soft bg-background px-6 pb-6 pt-3">
        <Button
          onPress={() => {
            void handleSubmit();
          }}
          loading={isSubmitting}
          disabled={
            isSubmitting || inlineErrorKind === 'non-retryable' || inlineErrorKind === 'reconnect'
          }
          accessibilityLabel="Submit review"
        >
          <Text>Submit review</Text>
        </Button>
        <Button
          variant="ghost"
          onPress={handleCancel}
          disabled={isSubmitting}
          className="mt-2"
          accessibilityLabel="Cancel"
        >
          <Text>Cancel</Text>
        </Button>
      </View>
    </View>
  );
}

function PendingQueueHint({
  queuedCount,
  hasStaleItems,
}: {
  queuedCount: number;
  hasStaleItems: boolean;
}) {
  let message = '';
  if (queuedCount === 0) {
    message = 'No comments queued. The review will be submitted with just the event above.';
  } else if (hasStaleItems) {
    message =
      'Some comments may be outdated because the PR head changed after they were queued. Submission will use the current head.';
  } else {
    message = 'All comments will be sent in a single batched request.';
  }
  return (
    <Text variant="muted" className="text-xs">
      {message}
    </Text>
  );
}

function ReviewBodyField({
  bodyRef,
  inputRef,
  isDisabled,
  onChange,
}: {
  bodyRef: RefObject<string>;
  inputRef: RefObject<TextInput | null>;
  isDisabled: boolean;
  onChange: () => void;
}) {
  const colors = useThemeColors();
  return (
    <TextInput
      ref={inputRef}
      defaultValue=""
      editable={!isDisabled}
      placeholder="Optional summary for the review"
      placeholderTextColor={colors.mutedForeground}
      accessibilityLabel="Review summary"
      onChangeText={value => {
        bodyRef.current = value;
        onChange();
      }}
      multiline
      textAlignVertical="top"
      className={cn(
        'min-h-24 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
        'focus:border-ring'
      )}
    />
  );
}
