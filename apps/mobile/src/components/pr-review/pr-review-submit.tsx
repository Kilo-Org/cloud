// Review-submit content: event radio, optional summary, pending-comments
// list (view/edit/delete), and one batched submitReview call. Queue is
// cleared on success and retained on failure.
//
// Disable lifetime: bad-request clears on event/summary change; forbidden
// stays for the rest of the sheet session. Toasts paint behind formSheets
// on iOS, so the mutation hook toasts onError AND the sheet shows inline.

import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, type TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { Text } from '@/components/ui/text';
import {
  PendingQueueHint,
  PrReviewPendingCommentRow,
  ReviewSummaryField,
} from '@/components/pr-review/pr-review-pending-comment-row';
import {
  buildSubmitReviewInput,
  type ReviewEvent,
} from '@/lib/pr-review/build-submit-review-input';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { mutationErrorDisplay } from '@/lib/pr-review/mutation-error-display';
import { type PendingReviewItem, usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useSubmitReviewMutation } from '@/lib/pr-review/use-pr-review-mutations';

const COMMENT_COMPOSER_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/comment-composer' as const;

type PrReviewSubmitProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  onDismiss: () => void;
}>;

const EVENT_OPTIONS: readonly { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
  { value: 'APPROVE', label: 'Approve' },
];

export function PrReviewSubmit(props: PrReviewSubmitProps) {
  const { owner, repo, number, headSha, onDismiss } = props;
  const router = useRouter();
  const pending = usePendingReview();
  const submitReview = useSubmitReviewMutation({ owner, repo, number });

  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);

  const bodyRef = useRef<string>('');
  const bodyInputRef = useRef<TextInput | null>(null);

  const isSubmitting = submitReview.isPending;
  const queuedCount = pending.items.length;
  const hasStaleItems = pending.items.some(item => item.commitSha !== headSha);

  useEffect(() => {
    if (submitReview.error) {
      const classification = classifyPrReviewMutationError(submitReview.error);
      const display = mutationErrorDisplay('submit', classification, submitReview.error);
      setInlineError(display.message);
      setInlineErrorKind(display.kind);
    }
  }, [submitReview.error]);

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
    inlineErrorKind === 'bad-request' ||
    inlineErrorKind === 'forbidden' ||
    inlineErrorKind === 'reconnect';

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
            clearRecoverableError();
          }}
        />
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">Summary (optional)</Text>
          <ReviewSummaryField
            bodyRef={bodyRef}
            inputRef={bodyInputRef}
            isDisabled={isSubmitting}
            onChange={clearRecoverableError}
          />
        </View>

        <View className="gap-2 rounded-lg border border-hair-soft bg-secondary p-3">
          <Text className="text-sm font-medium text-foreground">
            {queuedCount} pending {queuedCount === 1 ? 'comment' : 'comments'}
          </Text>
          <PendingQueueHint queuedCount={queuedCount} hasStaleItems={hasStaleItems} />
          {pending.items.map(item => (
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
          ))}
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
          className="mt-2"
          accessibilityLabel="Cancel"
        >
          <Text>Cancel</Text>
        </Button>
      </View>
    </View>
  );
}
