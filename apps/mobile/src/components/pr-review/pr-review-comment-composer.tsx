// S7a comment-composer content component. The orchestrator mounts this
// inside the `comment-composer.tsx` route (S4b left a thin stub there);
// the route supplies the route-params; this component owns the form
// body, the suggestion affordance, and both submit paths.
//
// Two submit actions, both available at once:
//   - "Add to review"   → enqueue into the `PendingReviewProvider`,
//     keep the selection alive, dismiss. The user keeps editing more
//     lines and submits the whole batch in the review-submit sheet.
//   - "Comment now"     → POST a single comment immediately via
//     `createReviewComment` and dismiss. No review state is created.
//
// Toasts paint behind formSheets on iOS, so the mutation hook toasts
// `onError` AND the sheet renders an inline error box. A 422 (e.g.
// stale line because the head moved) is a non-retryable inline message.

import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { buildSuggestionFence } from '@/lib/pr-review/build-suggestion-fence';
import { type DiffSelection, getDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useCreateReviewCommentMutation } from '@/lib/pr-review/use-pr-review-mutations';
import { cn } from '@/lib/utils';

type PrReviewCommentComposerProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  /** Current PR head SHA — pinned into both the queued and immediate comment. */
  headSha: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  /** Invoked after the user submits (either path) or cancels. */
  onDismiss: () => void;
}>;

const BODY_PLACEHOLDER = 'Leave a comment';

export function PrReviewCommentComposer(props: PrReviewCommentComposerProps) {
  const { owner, repo, number, headSha, path, side, line, startLine, onDismiss } = props;
  const pending = usePendingReview();
  const createComment = useCreateReviewCommentMutation({ owner, repo, number });

  // Read the bridge on mount to render the selected-line context. We
  // re-read on every render because the diff may have updated the
  // selection while the user was navigating here.
  const selection = getDiffSelection({ owner, repo, number });

  // iOS uncontrolled pattern: text lives in a ref, the input's visible
  // value is set via defaultValue once + setNativeProps for the
  // suggestion insert. No `value` + state (iOS bug).
  const bodyRef = useRef<string>('');
  const bodyInputRef = useRef<TextInput | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);

  const isSubmitting = createComment.isPending;
  const lineRangeLabel = rangeLabel(line, startLine);

  // When the mutation errors, classify it and mirror a short message into
  // the inline error box. The hook toasts the same message; this box is
  // the one the user actually sees in the formSheet.
  useEffect(() => {
    if (createComment.error) {
      const classification = classifyPrReviewMutationError(createComment.error);
      if (classification.kind === 'bad-request') {
        setInlineError(
          "This comment can't be posted. The selected line may have changed, or the PR may have been updated."
        );
        setInlineErrorKind('bad-request');
      } else if (classification.kind === 'forbidden') {
        setInlineError("You don't have permission to post a comment on this pull request.");
        setInlineErrorKind('forbidden');
      } else if (classification.kind === 'reconnect') {
        setInlineError('GitHub connection expired.');
        setInlineErrorKind('reconnect');
      } else {
        const message =
          createComment.error instanceof Error
            ? createComment.error.message
            : 'Could not post comment.';
        setInlineError(message);
        setInlineErrorKind('retryable');
      }
    }
  }, [createComment.error]);

  function handleAddToReview() {
    const body = bodyRef.current;
    if (body.trim().length === 0) {
      setInlineError('Comment body cannot be empty.');
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
    pending.addComment({
      id: Crypto.randomUUID(),
      path,
      side,
      line,
      ...(startLine !== undefined ? { startLine } : {}),
      body,
      commitSha: headSha,
    });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDismiss();
  }

  async function handleCommentNow() {
    const body = bodyRef.current;
    if (body.trim().length === 0) {
      setInlineError('Comment body cannot be empty.');
      setInlineErrorKind('bad-request');
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
    try {
      await createComment.mutateAsync({
        owner,
        repo,
        number,
        body,
        path,
        line,
        side,
        // The S3 Zod refine rejects a partial range: startLine and
        // startSide must come together. We pass startSide = side so
        // the body lands on the same side the user is looking at.
        ...(startLine !== undefined ? { startLine, startSide: side } : {}),
        commitSha: headSha,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDismiss();
    } catch {
      // The mutation's error is already classified into inlineError by
      // the effect above; swallow here so it doesn't become an unhandled
      // promise rejection.
    }
  }

  function handleCancel() {
    if (isSubmitting) {
      return;
    }
    if (bodyRef.current.trim().length > 0) {
      Alert.alert('Discard comment?', 'Your draft will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: onDismiss },
      ]);
      return;
    }
    onDismiss();
  }

  function handleInsertSuggestion() {
    if (side === 'LEFT') {
      return;
    }
    const selectedText = selection?.selectedText ?? '';
    const block = buildSuggestionFence(selectedText);
    if (block === null) {
      return;
    }
    bodyRef.current = block;
    bodyInputRef.current?.setNativeProps({
      text: block,
      selection: { start: block.length, end: block.length },
    });
    bodyInputRef.current?.focus();
  }

  const suggestionAvailable = side === 'RIGHT' && Boolean(selection?.selectedText);
  let suggestionDisabledReason: string | null = null;
  if (side === 'LEFT') {
    suggestionDisabledReason = 'Suggestions only apply to added lines.';
  } else if (!selection?.selectedText) {
    suggestionDisabledReason = 'Tap a diff line to enable suggestions.';
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
        <ContextPreview
          selection={selection}
          fallbackPath={path}
          fallbackLineLabel={lineRangeLabel}
          fallbackSide={side}
        />
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">Comment</Text>
          <CommentBodyField bodyRef={bodyRef} inputRef={bodyInputRef} isDisabled={isSubmitting} />
          <Button
            variant="ghost"
            size="sm"
            onPress={handleInsertSuggestion}
            disabled={!suggestionAvailable}
            accessibilityLabel="Insert a code suggestion"
            accessibilityHint={suggestionDisabledReason ?? undefined}
            className="self-start"
          >
            <Text>Insert suggestion</Text>
          </Button>
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
            void handleCommentNow();
          }}
          loading={isSubmitting}
          disabled={
            isSubmitting ||
            inlineErrorKind === 'bad-request' ||
            inlineErrorKind === 'forbidden' ||
            inlineErrorKind === 'reconnect'
          }
          accessibilityLabel="Comment now"
        >
          <Text>Comment now</Text>
        </Button>
        <Button
          variant="secondary"
          onPress={handleAddToReview}
          disabled={isSubmitting}
          className="mt-2"
          accessibilityLabel="Add to review"
        >
          <Text>Add to review</Text>
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

function CommentBodyField({
  bodyRef,
  inputRef,
  isDisabled,
}: {
  bodyRef: RefObject<string>;
  inputRef: RefObject<TextInput | null>;
  isDisabled: boolean;
}) {
  const colors = useThemeColors();
  return (
    <TextInput
      ref={inputRef}
      defaultValue=""
      editable={!isDisabled}
      placeholder={BODY_PLACEHOLDER}
      placeholderTextColor={colors.mutedForeground}
      accessibilityLabel="Comment body"
      onChangeText={value => {
        bodyRef.current = value;
      }}
      multiline
      textAlignVertical="top"
      // Explicit line-height (no `text-center` per the repo's iOS rule).
      // `leading-5` = line-height 20, font-size 14, matching the merge
      // sheet's commit message field.
      className={cn(
        'min-h-32 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
        'focus:border-ring'
      )}
    />
  );
}

function ContextPreview({
  selection,
  fallbackPath,
  fallbackLineLabel,
  fallbackSide,
}: {
  selection: DiffSelection | null;
  fallbackPath: string;
  fallbackLineLabel: string;
  fallbackSide: 'LEFT' | 'RIGHT';
}) {
  const path = selection?.path ?? fallbackPath;
  const side = selection?.side ?? fallbackSide;
  const lineLabel = selection ? rangeLabel(selection.line, selection.startLine) : fallbackLineLabel;
  const previewText = selection?.selectedText ?? '';
  return (
    <View className="gap-2 rounded-lg border border-hair-soft bg-secondary p-3">
      <Text className="font-mono-medium text-[11px] text-muted-foreground" numberOfLines={1}>
        {path} {side} {lineLabel}
      </Text>
      {previewText.length > 0 ? (
        <Text className="font-mono-medium text-[12px] leading-5 text-foreground" numberOfLines={6}>
          {previewText}
        </Text>
      ) : (
        <Text variant="muted" className="text-xs">
          Selected line context will appear here.
        </Text>
      )}
    </View>
  );
}

function rangeLabel(line: number, startLine?: number): string {
  if (startLine !== undefined && startLine !== line) {
    return `L${startLine}–L${line}`;
  }
  return `L${line}`;
}
