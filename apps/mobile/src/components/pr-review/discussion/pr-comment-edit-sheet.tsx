// Edit sheet for a posted PR comment the viewer owns: a body-only sibling of
// `pr-conversation-comment-composer.tsx` that reuses its chrome. It is both
// the READ surface for the comment's full text — the field opens with the
// existing body — and the UPDATE surface: Save sends the new body through
// `useUpdatePrCommentMutation`, whose settle invalidation renders the new text
// in the Discussion behind the sheet.
//
// An edit of a posted comment is not a draft, so there is no durable draft and
// nothing is persisted while the sheet is open; a discard just dismisses after
// one confirmation.
//
// Every failure path is visible: `useComposerInlineError(error, false,
// 'edit-comment')` mirrors the mutation error into the inline box below the
// field, the body stays intact, and a terminal classification (FORBIDDEN,
// reconnect, or a 404 for a comment that no longer exists) keeps Save down —
// their recovery lives outside the button. A retryable failure keeps Save live
// for the same tap.

import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, Keyboard, ScrollView, type TextInput, View } from 'react-native';

import {
  ComposerInlineError,
  useComposerInlineError,
} from '@/components/pr-review/composer-inline-error';
import { PrFormSheetFooter, PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { CommentBodyField } from '@/components/pr-review/pr-review-comment-composer-parts';
import { ensureTermsAcceptedOutcome } from '@/components/pr-review/discussion/reply-input';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { type PrCommentKind } from '@/lib/pr-review/discussion/review-discussion-types';
import { useUpdatePrCommentMutation } from '@/lib/pr-review/discussion/use-pr-comment-crud-mutations';

type PrCommentEditSheetProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  kind: PrCommentKind;
  /** The posted comment's current body, shown in full on open. */
  initialBody: string;
  onDismiss: () => void;
}>;

export function PrCommentEditSheet({
  owner,
  repo,
  number,
  commentId,
  kind,
  initialBody,
  onDismiss,
}: PrCommentEditSheetProps) {
  const { t } = useTranslation();
  const updateComment = useUpdatePrCommentMutation();

  // iOS uncontrolled: ref + defaultValue; no value+state.
  const bodyRef = useRef<string>(initialBody);
  const bodyInputRef = useRef<TextInput | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  // State only for derived UI: an empty body and an unchanged body both have
  // nothing to save, so each keeps Save down.
  const [hasBody, setHasBody] = useState(initialBody.trim().length > 0);
  const [dirty, setDirty] = useState(false);

  const {
    inlineError,
    inlineErrorKind,
    inlineErrorIsLocal,
    setInlineError,
    setInlineErrorKind,
    setInlineErrorIsLocal,
    clearBadRequestOnBodyEdit,
  } = useComposerInlineError(updateComment.error, false, 'edit-comment');

  const isSubmitting = updateComment.isPending;

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

  function handleBodyChange(value: string) {
    bodyRef.current = value;
    setHasBody(value.trim().length > 0);
    setDirty(value !== initialBody);
    // A bad-request clears on body edit — the failed write must not dead-end
    // the sheet; forbidden/reconnect stay until the next submit.
    clearBadRequestOnBodyEdit();
  }

  async function handleSubmit() {
    if (updateComment.isPending) {
      return;
    }
    const body = bodyRef.current;
    if (body.trim().length === 0) {
      setInlineError(t('prReview.composer.bodyEmpty'));
      setInlineErrorKind('bad-request');
      setInlineErrorIsLocal(true);
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
    setInlineErrorIsLocal(false);
    // Confirmed offline: fail the submit at once with the retryable copy
    // instead of starting a write React Query pauses, which leaves an
    // indefinite spinner with a disabled Cancel and no explanation behind the
    // full-height sheet (ux1 spot check, e6-offline-hang). The edited body
    // stays intact, nothing is pending, and the same tap retries once the
    // banner clears. A local rejection with no toast owner, so it announces
    // through AccessibleStatus.
    if (getCommittedConnectivityStatus() === 'offline') {
      setInlineError(t('prReview.discussion.commentEditFailed'));
      setInlineErrorKind('retryable');
      setInlineErrorIsLocal(true);
      return;
    }
    const outcome = await ensureTermsAcceptedOutcome();
    if (outcome.kind === 'outdated') {
      setInlineError(t('prReview.discussion.termsOutdatedCopy'));
      setInlineErrorKind('bad-request');
      setInlineErrorIsLocal(false);
      return;
    }
    if (outcome.kind === 'dismissed') {
      return;
    }
    try {
      await updateComment.mutateAsync({ owner, repo, number, commentId, kind, body });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The mutation hook announces success for a11y; its settle invalidation
      // renders the edited text in the discussion behind the sheet.
      onDismiss();
    } catch {
      // Classified into the inline box by `useComposerInlineError`.
    }
  }

  function handleCancel() {
    if (updateComment.isPending) {
      return;
    }
    // Read the ref, not the derived `dirty` state: the gate must see the text
    // the user just typed, even before the re-render that refreshes the
    // header/footer handlers.
    if (bodyRef.current !== initialBody) {
      Alert.alert(t('prReview.composer.discardTitle'), t('prReview.composer.discardMessage'), [
        { text: t('common.keepEditing'), style: 'cancel' },
        { text: t('common.discard'), style: 'destructive', onPress: onDismiss },
      ]);
      return;
    }
    onDismiss();
  }

  // Latest-handler ref: the hardware-back listener is armed once per mount and
  // must run the CURRENT render's gate (a stale closure would read the first
  // render's dirty/isPending). `true` consumes the event — handleCancel owns
  // the pop, so the router must not dismiss the sheet a second time under the
  // dialog.
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleCancelRef.current();
      return true;
    });
    return () => {
      sub.remove();
    };
  }, []);

  // An unchanged body has nothing to save; forbidden/reconnect/not-found keep
  // Save down because their recovery lives outside the button (the reconnect
  // notice CTA / leaving the sheet — a 404 means the comment is gone).
  const primaryDisabled =
    isSubmitting ||
    !hasBody ||
    !dirty ||
    inlineErrorKind === 'forbidden' ||
    inlineErrorKind === 'reconnect' ||
    inlineErrorKind === 'not-found';

  // PickerSheet invariant: [header, ScrollView] as direct children (no wrapper
  // View, no sticky-footer sibling). Footer is trailing scroll content so
  // keyboard insets keep the CTAs tappable without overpainting the pinned
  // header.
  return (
    <>
      <PrFormSheetHeader
        title={t('prReview.composer.editTitle')}
        eyebrow={`${owner}/${repo}#${number}`}
        onBack={handleCancel}
      />
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-background"
        contentContainerClassName="pb-1"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
      >
        <View className="gap-4 px-6 pt-4">
          <CommentBodyField
            inputRef={bodyInputRef}
            isDisabled={isSubmitting}
            defaultValue={initialBody}
            onChangeText={handleBodyChange}
          />
          <ComposerInlineError
            inlineError={inlineError}
            inlineErrorKind={inlineErrorKind}
            inlineErrorIsLocal={inlineErrorIsLocal}
          />
        </View>

        <PrFormSheetFooter>
          <Button
            onPress={() => {
              void handleSubmit();
            }}
            loading={isSubmitting}
            disabled={primaryDisabled}
            accessibilityLabel={t('common.save')}
          >
            <Text>{t('common.save')}</Text>
          </Button>
          <Button
            variant="ghost"
            onPress={handleCancel}
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
