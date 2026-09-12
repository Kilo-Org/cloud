// Composer for a regular PR conversation (issue) comment, opened from the
// Discussion tab's bottom CTA bar. Body-only sibling of
// pr-review-comment-composer.tsx: an issue comment needs no path/side/line
// anchor and no commit sha, so there is no getPullRequest fetch, no
// Add-to-review, and no suggestion insert.
//
// The durable draft (per account and PR) survives dismissal and failed
// submissions; it is cleared only on a successful post or a confirmed
// discard. Failures mirror ReplyInput's inline classification and preserve
// the draft so the user can retry without retyping.

import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler, Keyboard, ScrollView, type TextInput, View } from 'react-native';
import {
  ComposerInlineError,
  type ComposerInlineErrorKind,
} from '@/components/pr-review/composer-inline-error';
import { PrFormSheetFooter, PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { CommentBodyField } from '@/components/pr-review/pr-review-comment-composer-parts';
import { ensureTermsAcceptedOutcome } from '@/components/pr-review/discussion/reply-input';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { clearDraft, prConversationCommentDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  isPrOperationAmbiguous,
  isPrOperationPersistenceFailed,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import { useAddPrCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import { i18n } from '@/i18n';

type PrConversationCommentComposerProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  onDismiss: () => void;
}>;

export function PrConversationCommentComposer({
  owner,
  repo,
  number,
  onDismiss,
}: PrConversationCommentComposerProps) {
  const { t } = useTranslation();
  const addComment = useAddPrCommentMutation();

  // Durable comment draft, keyed by account and PR. Nothing is saved or
  // restored while the user id is unknown.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const commentDraftKey = prConversationCommentDraftKey(owner, repo, number);
  const draft = useFencedDraftLoad({ userId, isIdentityLoading, entityKey: commentDraftKey });
  useDraftFlushOnBackground(userId, commentDraftKey, true);

  // iOS uncontrolled: ref + defaultValue; no value+state.
  const bodyRef = useRef<string>('');
  const bodyInputRef = useRef<TextInput | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  // Seed the refs from the settled draft once per identity/destination, during
  // render, before the body field mounts. Re-seeding on a key change (and
  // resetting to empty when there is no draft) keeps a reused instance from
  // showing or saving the previous account's or PR's text.
  const draftSeedKeyRef = useRef<string | null>(null);
  const draftSeedKey = `${userId ?? 'anonymous'}\u0000${commentDraftKey}`;
  if (draft.settled && draftSeedKeyRef.current !== draftSeedKey) {
    draftSeedKeyRef.current = draftSeedKey;
    bodyRef.current = draft.value ?? '';
  }

  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<ComposerInlineErrorKind>(null);
  const [inlineErrorIsLocal, setInlineErrorIsLocal] = useState(false);
  // The ONLY server failure that must block a retry is the ledger persistence
  // marker (the row never became `reconcile_pending`, so the ambiguous-outcome
  // promise does not hold). Every other server rejection — bad-request
  // included — keeps Comment enabled: the failed post must never dead-end the
  // composer, and a blind retry is ledger-safe (non-retryable failures rotate
  // the operation key, retryable ones dedupe on the same key).
  const [retryBlocked, setRetryBlocked] = useState(false);

  const isSubmitting = addComment.isPending;

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

  // Mirror the mutation error into the inline box (ReplyInput's inline
  // classification). The add-comment mutation is NOT optimistic, so the user
  // can hit the inline error and retry without waiting for a re-fetch. Every
  // failure path preserves the draft, and every failure path except the
  // retry-blocking ledger marker re-enables Comment for the retry.
  useEffect(() => {
    if (!addComment.error) {
      return;
    }
    setInlineErrorIsLocal(false);
    // The ledger persistence-failure marker is retry-blocking: the same
    // operation key must not be retried.
    if (isPrOperationPersistenceFailed(addComment.error)) {
      setInlineError(i18n.t('prReview.operation.persistenceFailed'));
      setInlineErrorKind('bad-request');
      setRetryBlocked(true);
      return;
    }
    setRetryBlocked(false);
    const classification = classifyPrReviewMutationError(addComment.error);
    if (isPrOperationAmbiguous(addComment.error)) {
      // The effect may have committed: the user must verify the PR, not be
      // shown the generic retryable copy. Retry stays enabled.
      setInlineError(i18n.t('prReview.operation.ambiguous'));
      setInlineErrorKind('retryable');
    } else if (classification.kind === 'terms-required') {
      void (async () => {
        const outcome = await ensureTermsAcceptedOutcome();
        if (outcome.kind === 'accepted') {
          setInlineError(null);
          setInlineErrorKind(null);
        } else if (outcome.kind === 'outdated') {
          setInlineError(t('prReview.discussion.termsOutdatedCopy'));
          setInlineErrorKind('bad-request');
        } else if (outcome.kind === 'unknown') {
          setInlineError(t('prReview.discussion.termsCheckRetryCopy'));
          setInlineErrorKind('retryable');
        } else {
          setInlineError(t('prReview.discussion.termsCopy'));
          setInlineErrorKind(null);
        }
      })();
    } else if (classification.kind === 'bad-request') {
      setInlineError(t('prReview.discussion.commentBadRequest'));
      setInlineErrorKind('bad-request');
    } else if (classification.kind === 'forbidden') {
      // The provider-permission fallback: the PR DTO carries no can-comment
      // signal, so a permission rejection surfaces here as inline copy.
      setInlineError(t('prReview.discussion.commentForbidden'));
      setInlineErrorKind('forbidden');
    } else if (classification.kind === 'reconnect') {
      setInlineError(t('prReview.connectionExpired'));
      setInlineErrorKind('reconnect');
    } else {
      // A generic/transient failure shows the specified retryable copy, never
      // the raw provider error (the backend's GitHub access/install text is
      // actionable to nobody; the toast and the inline box must agree). The
      // draft stays intact and Comment stays enabled for the retry (uxs3 spot
      // check, e6-offline-banner).
      setInlineError(t('prReview.mutationError.couldNotPostComment'));
      setInlineErrorKind('retryable');
    }
  }, [addComment.error, t]);

  function handleBodyChange(value: string) {
    bodyRef.current = value;
    // A bad-request error clears on body edit — including the retry-blocking
    // persistence marker, whose edit changes the intent fingerprint anyway;
    // forbidden/reconnect stay until the next submit.
    if (inlineErrorKind === 'bad-request') {
      setInlineError(null);
      setInlineErrorKind(null);
      setInlineErrorIsLocal(false);
      setRetryBlocked(false);
    }
    if (userId) {
      saveDraft(userId, commentDraftKey, value);
    }
  }

  async function handleSubmit() {
    if (addComment.isPending) {
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
    setRetryBlocked(false);
    // Confirmed offline: fail the submit at once with the retryable copy
    // instead of starting a request that hangs on the UI deadline behind a
    // spinner with a disabled Cancel (uxs3 spot check, e6-offline-hang). The
    // draft stays intact, nothing is pending, and the same tap retries once
    // the banner clears. This is a local rejection with no toast owner, so it
    // announces through AccessibleStatus.
    if (getCommittedConnectivityStatus() === 'offline') {
      setInlineError(t('prReview.mutationError.couldNotPostComment'));
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
      await addComment.mutateAsync({ owner, repo, number, body });
      if (userId) {
        void clearDraft(userId, commentDraftKey);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The mutation hook announces success for a11y; its settle invalidation
      // renders the posted comment in the discussion behind the sheet.
      onDismiss();
    } catch {
      // Classified into the inline box by the effect above; the draft is
      // preserved so the user can retry.
    }
  }

  function handleCancel() {
    if (addComment.isPending) {
      return;
    }
    if (bodyRef.current.trim().length > 0) {
      Alert.alert(t('prReview.composer.discardTitle'), t('prReview.composer.discardMessage'), [
        { text: t('common.keepEditing'), style: 'cancel' },
        {
          text: t('common.discard'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              // The clear must SETTLE before the dismiss: the next open's
              // draft load races an in-flight removeItem otherwise, and the
              // discarded text reappears for one open. When the clear FAILS,
              // stay on the composer with the text intact (the drafts.ts
              // contract for the returned boolean): dismissing anyway would
              // resurface the draft on the next open as if the discard never
              // happened. The Cancel/back gate is the retry CTA, so the
              // inline error is retryable.
              if (userId) {
                const cleared = await clearDraft(userId, commentDraftKey);
                if (!cleared) {
                  setInlineError(t('agentChat.newSession.discardFailed'));
                  setInlineErrorKind('retryable');
                  setInlineErrorIsLocal(true);
                  return;
                }
              }
              onDismiss();
            })();
          },
        },
      ]);
      return;
    }
    onDismiss();
  }

  // Latest-handler ref (the pr-diff-file-navigator.tsx pattern): the
  // hardware-back listener is armed once per mount and must run the CURRENT
  // render's gate. The first render can predate identity — a first-render
  // closure would keep a null userId and silently skip the draft clear on a
  // confirmed discard, and a stale isPending would let back pop the sheet
  // mid-submit.
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;

  // The hardware back press runs the same gate as the header close and the
  // footer Cancel: text present asks before discarding. Without the
  // interception the back press pops the sheet directly and the discard
  // dialog never appears. `true` consumes the event — handleCancel owns the
  // pop (onDismiss → router.back), so the router must not pop it a second
  // time under the dialog. One implementation for both platforms: BackHandler
  // is RN's cross-platform back API (Android fires it for the hardware/gesture
  // back; on iOS RN ships it as a never-firing no-op, where the formSheet
  // swipe-down is the back affordance and the durable draft covers it).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleCancelRef.current();
      return true;
    });
    return () => {
      sub.remove();
    };
  }, []);

  // A failed post never dead-ends the composer: only the LOCAL empty-body
  // validation and the retry-blocking persistence marker keep Comment down
  // (both clear on the next edit or submit). forbidden/reconnect stay down
  // because their recovery lives outside the submit button (the reconnect
  // notice CTA / leaving the sheet); a server bad-request stays retryable so
  // the user can re-post without retyping — the ledger dedupes the retry.
  const submitDisabled =
    isSubmitting ||
    (inlineErrorKind === 'bad-request' && (inlineErrorIsLocal || retryBlocked)) ||
    inlineErrorKind === 'forbidden' ||
    inlineErrorKind === 'reconnect';

  // PickerSheet invariant: [header, ScrollView] as direct children (no
  // wrapper View, no sticky-footer sibling). Footer is trailing scroll
  // content so keyboard insets keep CTAs tappable without overpainting the
  // pinned header. The header close runs the SAME discard gate as the
  // footer Cancel: text present asks before discarding (Android hardware
  // back is intercepted into the same gate). Only a confirmed discard (or a
  // successful post) clears the draft; a dismissal that keeps the text —
  // keep editing, drag-down — relies on the durable draft, so the unmount
  // flush must stay enabled.
  return (
    <>
      <PrFormSheetHeader
        title={t('prReview.composer.addTitle')}
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
          {draft.settled ? (
            <CommentBodyField
              inputRef={bodyInputRef}
              isDisabled={isSubmitting}
              defaultValue={bodyRef.current}
              onChangeText={handleBodyChange}
            />
          ) : null}
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
            disabled={submitDisabled}
            accessibilityLabel={t('prReview.composer.comment')}
          >
            <Text>{t('prReview.composer.comment')}</Text>
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
