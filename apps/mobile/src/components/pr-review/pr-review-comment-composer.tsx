// Comment-composer content. Two modes:
//   - create: Comment now + Add to review + Insert suggestion (needs headSha).
//   - edit: single Save updating a queued PendingReviewItem (local-only).
// Toasts paint behind formSheets on iOS — mutation hook toasts onError AND
// the sheet renders an inline error box.

import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, ScrollView, type TextInput, View } from 'react-native';

import {
  PrFormSheetHeader,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import {
  CommentBodyField,
  ComposerFooter,
  composerRangeLabel,
  ContextPreview,
} from '@/components/pr-review/pr-review-comment-composer-parts';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { buildSuggestionFence } from '@/lib/pr-review/build-suggestion-fence';
import { getDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { mutationErrorDisplay } from '@/lib/pr-review/mutation-error-display';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useCreateReviewCommentMutation } from '@/lib/pr-review/use-pr-review-mutations';

type CommentComposerMode =
  | { kind: 'create'; headSha: string }
  | { kind: 'edit'; pendingItemId: string };

type PrReviewCommentComposerProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  mode: CommentComposerMode;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  startLine?: number;
  /** Seeded body (edit) / empty (create). Also the dirty-check baseline. */
  initialBody?: string;
  title: string;
  eyebrow: string;
  onDismiss: () => void;
}>;

export function PrReviewCommentComposer(props: PrReviewCommentComposerProps) {
  const {
    owner,
    repo,
    number,
    mode,
    path,
    side,
    line,
    startLine,
    initialBody = '',
    title,
    eyebrow,
    onDismiss,
  } = props;
  const pending = usePendingReview();
  const createComment = useCreateReviewCommentMutation({ owner, repo, number });
  const isEdit = mode.kind === 'edit';

  // Edit mode ignores the bridge so editing A never shows B's path/lines.
  const selection = isEdit ? null : getDiffSelection({ owner, repo, number });

  // iOS uncontrolled: ref + defaultValue; no value+state.
  const bodyRef = useRef<string>(initialBody);
  const bodyBaselineRef = useRef<string>(initialBody);
  const bodyInputRef = useRef<TextInput | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const [hasBody, setHasBody] = useState(() => initialBody.trim().length > 0);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);

  const isSubmitting = !isEdit && createComment.isPending;
  const lineRangeLabel = composerRangeLabel(line, startLine);

  useEffect(() => {
    if (isEdit || !createComment.error) {
      return;
    }
    const classification = classifyPrReviewMutationError(createComment.error);
    const display = mutationErrorDisplay('composer', classification, createComment.error);
    setInlineError(display.message);
    setInlineErrorKind(display.kind);
  }, [createComment.error, isEdit]);

  // automaticallyAdjustKeyboardInsets can scroll the focused field under the
  // pinned header. Compact kb layout fits at offset 0 — snap back so body +
  // footer CTAs stay in the inset viewport together.
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

  function clearBadRequestOnBodyEdit() {
    // bad-request clears on body change; forbidden stays for the session.
    if (inlineErrorKind === 'bad-request') {
      setInlineError(null);
      setInlineErrorKind(null);
    }
  }

  function handleBodyChange(value: string) {
    bodyRef.current = value;
    setHasBody(value.trim().length > 0);
    clearBadRequestOnBodyEdit();
  }

  function handleAddToReview() {
    if (mode.kind !== 'create') {
      return;
    }
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
      commitSha: mode.headSha,
    });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDismiss();
  }

  async function handleCommentNow() {
    if (mode.kind !== 'create') {
      return;
    }
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
        ...(startLine !== undefined ? { startLine, startSide: side } : {}),
        commitSha: mode.headSha,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDismiss();
    } catch {
      // Classified into inlineError by the effect above.
    }
  }

  function handleSave() {
    if (mode.kind !== 'edit') {
      return;
    }
    const trimmed = bodyRef.current.trim();
    if (trimmed.length === 0) {
      return;
    }
    pending.updateComment(mode.pendingItemId, trimmed);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDismiss();
  }

  function handleCancel() {
    if (isSubmitting) {
      return;
    }
    const dirty = isEdit
      ? bodyRef.current !== bodyBaselineRef.current
      : bodyRef.current.trim().length > 0;
    if (dirty) {
      Alert.alert('Discard comment?', 'Your draft will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: onDismiss },
      ]);
      return;
    }
    onDismiss();
  }

  function handleInsertSuggestion() {
    if (isEdit || side === 'LEFT') {
      return;
    }
    const block = buildSuggestionFence(selection?.selectedText ?? '');
    if (block === null) {
      return;
    }
    bodyRef.current = block;
    setHasBody(block.trim().length > 0);
    clearBadRequestOnBodyEdit();
    bodyInputRef.current?.setNativeProps({
      text: block,
      selection: { start: block.length, end: block.length },
    });
    bodyInputRef.current?.focus();
  }

  const keyboardVisible = useFormSheetKeyboardVisible();
  const suggestionAvailable = !isEdit && side === 'RIGHT' && Boolean(selection?.selectedText);
  let suggestionDisabledReason: string | null = null;
  if (!isEdit) {
    if (side === 'LEFT') {
      suggestionDisabledReason = 'Suggestions only apply to added lines.';
    } else if (!selection?.selectedText) {
      suggestionDisabledReason = 'Tap a diff line to enable suggestions.';
    }
  }
  // Half-detent needs every row for footer CTAs; surface Insert only once the
  // keyboard has expanded the sheet and compacted the body field.
  const showInsertSuggestion = suggestionAvailable && keyboardVisible;

  const primaryDisabled =
    isSubmitting ||
    inlineErrorKind === 'forbidden' ||
    inlineErrorKind === 'reconnect' ||
    (!isEdit && inlineErrorKind === 'bad-request') ||
    (isEdit && !hasBody);

  // PickerSheet invariant: [header, ScrollView] as direct children (no
  // wrapper View, no sticky-footer sibling). Footer is trailing scroll
  // content so keyboard insets + AppAwareKeyboardPaddingView keep CTAs
  // tappable without overpainting the pinned header.
  return (
    <>
      <PrFormSheetHeader title={title} eyebrow={eyebrow} onBack={onDismiss} />
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-background"
        contentContainerClassName="pb-1"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
      >
        <View className="gap-1.5 px-6 pt-1.5">
          <ContextPreview
            selection={selection}
            fallbackPath={path}
            fallbackLineLabel={lineRangeLabel}
            fallbackSide={side}
            preferFallback={isEdit}
          />
          <View className="gap-1">
            <Text className="text-xs font-medium text-foreground">Comment</Text>
            <CommentBodyField
              inputRef={bodyInputRef}
              isDisabled={isSubmitting}
              defaultValue={initialBody}
              onChangeText={handleBodyChange}
            />
            {showInsertSuggestion ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={handleInsertSuggestion}
                accessibilityLabel="Insert a code suggestion"
                accessibilityHint={suggestionDisabledReason ?? undefined}
                className="self-start"
              >
                <Text>Insert suggestion</Text>
              </Button>
            ) : null}
          </View>
          {inlineError && inlineErrorKind !== 'reconnect' ? (
            <View
              className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 px-2.5 py-1.5"
              accessibilityLiveRegion="polite"
            >
              <Text className="text-xs text-destructive">{inlineError}</Text>
            </View>
          ) : null}
          {inlineErrorKind === 'reconnect' ? <PrReviewReconnectNotice /> : null}
        </View>

        <ComposerFooter
          isEdit={isEdit}
          isSubmitting={isSubmitting}
          primaryDisabled={primaryDisabled}
          onSave={handleSave}
          onCommentNow={() => {
            void handleCommentNow();
          }}
          onAddToReview={handleAddToReview}
          onCancel={handleCancel}
        />
      </ScrollView>
    </>
  );
}
