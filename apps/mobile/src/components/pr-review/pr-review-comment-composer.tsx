/* eslint-disable max-lines -- the comment composer owns the durable comment draft (load, save, seed, clear) beside the existing create/edit form; the draft wiring stays with the form it persists */
// Comment-composer content. Two modes:
//   - create: Comment now + Add to review + Insert suggestion (needs headSha).
//   - edit: single Save updating a queued PendingReviewItem (local-only).
// Toasts paint behind formSheets on iOS — mutation hook toasts onError AND
// the sheet renders an inline error box.

import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { impactHaptic, notificationHaptic } from '@/lib/haptics';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, ScrollView, type ScrollViewInstance, type TextInput, View } from 'react-native';

import {
  PrFormSheetHeader,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import { ComposerInlineError } from '@/components/pr-review/composer-inline-error';
import {
  CommentBodyField,
  ComposerFooter,
  composerRangeLabel,
  ContextPreview,
} from '@/components/pr-review/pr-review-comment-composer-parts';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { ensureTermsAcceptedOutcome } from '@/components/pr-review/discussion/reply-input';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { connectionRefusesWrites } from '@/lib/hooks/use-offline-banner-state';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { type SurfaceAttempt } from '@/lib/surface-feedback';
import { clearDraft, prCommentDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { buildSuggestionFence } from '@/lib/pr-review/build-suggestion-fence';
import { getDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { classifyPrInlineFailure, type PrInlineFailure } from '@/lib/pr-review/inline-failure';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { useCreateReviewCommentMutation } from '@/lib/pr-review/use-pr-review-mutations';
import {
  type ProviderPrRef,
  providerPrRefKey,
  useProviderPrScopeOrNull,
} from '@/lib/pr-review/provider-pr-ref';

type CommentComposerMode =
  | { kind: 'create'; headSha: string }
  | { kind: 'edit'; pendingItemId: string };

type PrReviewCommentComposerProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  /**
   * The provider ref (s6). Present on the GitLab/Bitbucket surface: the
   * comment posts through `providerReview.addComment` with the tapped diff
   * position as a real anchor (c3), and the durable comment draft key folds
   * the ref identity so a same-numbered GitHub PR never shares this sheet's
   * draft. Absent on GitHub, which keeps the exact pre-s6 write path.
   */
  prRef?: ProviderPrRef;
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

/** Failure kinds whose recovery lives outside the primary control. */
const BLOCKING = new Set<PrInlineFailure['kind']>([
  'body-empty',
  'bad-request',
  'forbidden',
  'reconnect',
  'not-found',
  'not-recorded',
]);

export function PrReviewCommentComposer(props: PrReviewCommentComposerProps) {
  const {
    owner,
    repo,
    number,
    prRef,
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
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const createComment = useCreateReviewCommentMutation(prRef ?? { owner, repo, number });
  const isEdit = mode.kind === 'edit';

  // Durable comment draft (create mode only). Edit mode edits an already-queued
  // item, durable through the pending-review provider, so no draft there.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const positionDraftKey = prCommentDraftKey(owner, repo, number, path, side, line, startLine);
  // Provider arms fold the collision-free ref identity into the key (identity
  // rule 17); the GitHub bytes stay exactly as stored before this slice.
  const commentDraftKey = prRef
    ? `${positionDraftKey}@${providerPrRefKey(prRef)}`
    : positionDraftKey;
  const draftUserId = isEdit ? undefined : userId;
  const draft = useFencedDraftLoad({
    userId: draftUserId,
    isIdentityLoading,
    entityKey: commentDraftKey,
  });
  useDraftFlushOnBackground(draftUserId, commentDraftKey, true);

  // Edit mode ignores the bridge so editing A never shows B's path/lines.
  const selection = isEdit ? null : getDiffSelection({ owner, repo, number, ref: prRef });

  // iOS uncontrolled: ref + defaultValue; no value+state.
  const bodyRef = useRef<string>(initialBody);
  const bodyBaselineRef = useRef<string>(initialBody);
  const bodyInputRef = useRef<TextInput | null>(null);
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const [hasBody, setHasBody] = useState(() => initialBody.trim().length > 0);
  // Seed the refs from the settled draft once per identity/destination, before
  // the body field mounts (create mode only). Re-seeding on a key change (and
  // resetting to the initial body when there is no draft) keeps a reused
  // instance from showing or saving the previous account's or position's text.
  const draftSeedKeyRef = useRef<string | null>(null);
  const draftSeedKey = `${draftUserId ?? 'anonymous'}\u0000${commentDraftKey}`;
  if (!isEdit && draft.settled && draftSeedKeyRef.current !== draftSeedKey) {
    draftSeedKeyRef.current = draftSeedKey;
    bodyRef.current = draft.value ?? initialBody;
    bodyBaselineRef.current = draft.value ?? initialBody;
  }
  const { feedback, failure, begin, clearWhere } = useSurfaceFeedback<PrInlineFailure>();
  // The route publishes the provider scope for every pr-review screen; a
  // GitLab/Bitbucket composer names its own provider in the reconnect copy.
  const platform = useProviderPrScopeOrNull()?.ref.platform;

  const isSubmitting = feedback.status === 'pending';
  // The Terms gate runs before the write is dispatched, so it must not lock
  // dismissal: a stalled status read would otherwise leave a dead Cancel behind
  // a spinner. Cancel stays live while the gate is the only work in flight.
  const [awaitingGate, setAwaitingGate] = useState(false);
  const dismissalLocked = isSubmitting && !awaitingGate;
  // The attempt admitted for a submit whose Terms gate is still running; a
  // dismissal abandons it so the continuation leaves nothing to write.
  const gateAttemptRef = useRef<SurfaceAttempt<PrInlineFailure> | null>(null);
  const lineRangeLabel = composerRangeLabel(line, startLine);

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
    // An edit retires the recoverable rejections — including the local
    // empty-body validation.
    clearWhere(
      f => f.kind === 'bad-request' || f.kind === 'body-empty' || f.kind === 'not-recorded'
    );
    if (draftUserId) {
      saveDraft(draftUserId, commentDraftKey, value);
    }
  }

  function handleAddToReview() {
    if (mode.kind !== 'create') {
      return;
    }
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    const body = bodyRef.current;
    if (body.trim().length === 0) {
      attempt.fail({
        kind: 'body-empty',
        message: t('prReview.composer.bodyEmpty'),
        announce: 'here',
      });
      return;
    }
    pending.addComment({
      id: Crypto.randomUUID(),
      path,
      side,
      line,
      ...(startLine !== undefined ? { startLine } : {}),
      body,
      commitSha: mode.headSha,
    });
    attempt.abandon();
    if (draftUserId) {
      void clearDraft(draftUserId, commentDraftKey);
    }
    impactHaptic(Haptics.ImpactFeedbackStyle.Light);
    onDismiss();
  }

  async function handleCommentNow() {
    if (mode.kind !== 'create') {
      return;
    }
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    const body = bodyRef.current;
    if (body.trim().length === 0) {
      attempt.fail({
        kind: 'body-empty',
        message: t('prReview.composer.bodyEmpty'),
        announce: 'here',
      });
      return;
    }
    // Confirmed offline: fail at once with the retryable copy instead of
    // starting a write React Query pauses, which would look like a stuck
    // submit. The body stays intact and the same tap retries.
    if (connectionRefusesWrites()) {
      attempt.fail({
        kind: 'retryable',
        message: t('prReview.mutationError.couldNotPostComment'),
        announce: 'here',
      });
      return;
    }
    setAwaitingGate(true);
    gateAttemptRef.current = attempt;
    const outcome = await ensureTermsAcceptedOutcome();
    // A newer attempt may own the slot by now (the user cancelled this one and
    // started another while this gate was pending): only the owner clears it.
    if (gateAttemptRef.current === attempt) {
      gateAttemptRef.current = null;
      setAwaitingGate(false);
    }
    if (!attempt.owns()) {
      // Dismissed (or unmounted) while the gate ran: this token no longer owns
      // the phase, so it must not dispatch the write.
      return;
    }
    if (outcome.kind === 'dismissed') {
      attempt.abandon();
      return;
    }
    if (outcome.kind === 'outdated') {
      attempt.fail({
        kind: 'bad-request',
        message: t('prReview.discussion.termsOutdatedCopy'),
        announce: 'toast',
      });
      return;
    }
    try {
      // Provider arms post the real diff position (c3): the sheet's
      // path/side/line selection rides the `anchor` the provider router
      // turns into an inline discussion / inline comment.
      await createComment.mutateAsync(
        prRef
          ? {
              body,
              anchor: {
                path,
                side,
                line,
                ...(startLine !== undefined ? { startLine } : {}),
              },
            }
          : {
              owner,
              repo,
              number,
              body,
              path,
              line,
              side,
              ...(startLine !== undefined ? { startLine, startSide: side } : {}),
              commitSha: mode.headSha,
            }
      );
      attempt.succeed();
      if (draftUserId) {
        void clearDraft(draftUserId, commentDraftKey);
      }
      notificationHaptic(Haptics.NotificationFeedbackType.Success);
      onDismiss();
    } catch (error) {
      const classified = await classifyPrInlineFailure(error, {
        surface: 'composer',
        platform,
        announce: 'toast',
      });
      if (classified.kind === 'failure') {
        attempt.fail(classified.failure);
      } else {
        attempt.abandon();
      }
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
    impactHaptic(Haptics.ImpactFeedbackStyle.Light);
    onDismiss();
  }

  function handleCancel() {
    if (dismissalLocked) {
      return;
    }
    // A pending gate is not a write: leaving abandons the admitted attempt.
    gateAttemptRef.current?.abandon();
    gateAttemptRef.current = null;
    const dirty = isEdit
      ? bodyRef.current !== bodyBaselineRef.current
      : bodyRef.current.trim().length > 0;
    if (dirty) {
      confirm({
        title: t('prReview.composer.discardTitle'),
        message: t('prReview.composer.discardMessage'),
        confirmLabel: t('common.discard'),
        cancelLabel: t('common.keepEditing'),
        onConfirm: () => {
          if (draftUserId) {
            void clearDraft(draftUserId, commentDraftKey);
          }
          onDismiss();
        },
      });
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
    clearWhere(
      f => f.kind === 'bad-request' || f.kind === 'body-empty' || f.kind === 'not-recorded'
    );
    // Persist the inserted suggestion like a typed change, so a process kill
    // after Insert (with no later keystroke) does not lose the suggestion.
    if (draftUserId) {
      saveDraft(draftUserId, commentDraftKey, block);
    }
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
      suggestionDisabledReason = t('prReview.composer.suggestionsOnlyAddedLines');
    } else if (!selection?.selectedText) {
      suggestionDisabledReason = t('prReview.composer.tapDiffLineToSuggest');
    }
  }
  // Half-detent needs every row for footer CTAs; surface Insert only once the
  // keyboard has expanded the sheet and compacted the body field.
  const showInsertSuggestion = suggestionAvailable && keyboardVisible;

  // A failure whose recovery lives outside the primary control keeps it down:
  // empty body needs an edit, a rejection may have changed the PR, and
  // forbidden/reconnect/not-found/not-recorded each have their own next step.
  const primaryDisabled =
    isSubmitting || (failure !== null && BLOCKING.has(failure.kind)) || (isEdit && !hasBody);

  // One row, never both: the reason is set only when Insert cannot apply, so the
  // copy can never attach to the button, and the button renders only when there
  // is no reason. A selected line with the keyboard still closed draws neither —
  // Insert is available, just withheld until the sheet expands.
  let suggestionControl: ReactNode = null;
  if (suggestionDisabledReason !== null) {
    suggestionControl = (
      <Text testID="pr-comment-suggestion-unavailable" className="text-xs text-muted-foreground">
        {suggestionDisabledReason}
      </Text>
    );
  } else if (showInsertSuggestion) {
    suggestionControl = (
      <Button
        variant="ghost"
        size="sm"
        onPress={handleInsertSuggestion}
        accessibilityLabel={t('prReview.composer.insertSuggestionA11y')}
        className="self-start"
      >
        <Text>{t('prReview.composer.insertSuggestion')}</Text>
      </Button>
    );
  }

  // PickerSheet invariant: [header, ScrollView] as direct children (no
  // wrapper View, no sticky-footer sibling). Footer is trailing scroll
  // content so the keyboard insets the scroll body and the comment CTA stays
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
        <View className={SCREEN_BODY_CLASS}>
          <ContextPreview
            selection={selection}
            fallbackPath={path}
            fallbackLineLabel={lineRangeLabel}
            preferFallback={isEdit}
          />
          <View className="gap-1">
            <Text className="text-sm font-medium text-foreground">
              {t('prReview.composer.commentBody')}
            </Text>
            {isEdit || draft.settled ? (
              <CommentBodyField
                inputRef={bodyInputRef}
                isDisabled={isSubmitting}
                defaultValue={bodyRef.current}
                onChangeText={handleBodyChange}
              />
            ) : (
              // Reserve the field's own box while the durable draft loads, so
              // the footer below does not jump when the field mounts.
              <View
                className={
                  keyboardVisible
                    ? 'min-h-12 rounded-md border border-transparent'
                    : 'min-h-14 rounded-md border border-transparent'
                }
              />
            )}
            {suggestionControl}
          </View>
          <ComposerInlineError feedback={feedback} />
        </View>

        <ComposerFooter
          isEdit={isEdit}
          isSubmitting={isSubmitting}
          dismissalLocked={dismissalLocked}
          primaryDisabled={primaryDisabled}
          onSave={handleSave}
          onCommentNow={() => {
            void handleCommentNow();
          }}
          onAddToReview={handleAddToReview}
          onCancel={handleCancel}
        />
      </ScrollView>
      {dialog}
    </>
  );
}
