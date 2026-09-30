// Reply input for a single review thread. The input is uncontrolled
// (iOS ref pattern) per the repo's iOS rule. Submit calls the
// (non-optimistic) reply mutation and re-fetches the list on settle.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearDraft, prReplyDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import {
  isPrOperationAmbiguous,
  isPrOperationPersistenceFailed,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';

import { ensureTermsAcceptedOutcome } from './terms-gate';

export { ensureTermsAcceptedOutcome };

type ReplyInputProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly commentId: number;
  readonly reply: ReturnType<typeof useReplyToCommentMutation>;
  /**
   * The provider arm (s6). Present on a GitLab MR / Bitbucket PR thread:
   * the reply posts `{ threadId, commentNodeId, body }` through the
   * `providerReview` seam (GitLab answers inside the discussion, Bitbucket
   * attaches to the root comment), and the durable draft key folds the
   * collision-free ref identity so the same-numbered PR on another provider
   * can never share this reply's draft (identity rule 17). Absent on GitHub,
   * which keeps the exact pre-s6 call and key bytes.
   */
  readonly provider?: {
    readonly ref: ProviderPrRef;
    readonly threadId: string;
    readonly commentNodeId: string;
  };
  /**
   * Invoked when the reply field gains focus. The discussion tab uses it to
   * scroll the focused thread row above the keyboard-lifted bottom CTA bar
   * (see useReplyFocusScroll); optional because not every host scrolls.
   */
  readonly onInputFocus?: () => void;
};

export function ReplyInput({
  owner,
  repo,
  number,
  commentId,
  reply,
  provider,
  onInputFocus,
}: Readonly<ReplyInputProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const bodyRef = useRef<string>('');
  const inputRef = useRef<TextInput | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);
  // True when `inlineError` is a LOCAL validation error (the empty-body reject
  // returns before the mutation runs), so no toast owns it and it must
  // announce through AccessibleStatus. Mutation-classified errors are
  // toast-owned (the reply mutation hook's onError) and stay visual-only so
  // they never double-announce.
  const [inlineErrorIsLocal, setInlineErrorIsLocal] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  // The provider platform as a stable primitive: the error effect words a
  // refusal after it without depending on the `provider` object identity.
  const providerPlatform = provider?.ref.platform;

  // Durable reply draft, keyed by account and thread. Nothing is saved or
  // restored while the user id is unknown.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const positionReplyDraftKey = prReplyDraftKey(owner, repo, number, commentId);
  // Provider arms fold the collision-free ref identity into the key (identity
  // rule 17); the GitHub bytes stay exactly as stored before this slice.
  const replyDraftKey = provider
    ? `${positionReplyDraftKey}@${providerPrRefKey(provider.ref)}`
    : positionReplyDraftKey;
  const draft = useFencedDraftLoad({ userId, isIdentityLoading, entityKey: replyDraftKey });
  useDraftFlushOnBackground(userId, replyDraftKey, true);

  // Seed the field once per identity/thread, during render, before the input
  // mounts. The settled gate already unmounts the field on an identity/entity
  // change, so re-seeding here (and resetting to empty when there is no draft)
  // keeps a reused instance from showing or saving the previous account's or
  // thread's text under the new key.
  const replySeedKey = `${userId ?? 'anonymous'}\u0000${replyDraftKey}`;
  const seededKeyRef = useRef<string | null>(null);
  if (draft.settled && seededKeyRef.current !== replySeedKey) {
    seededKeyRef.current = replySeedKey;
    bodyRef.current = draft.value ?? '';
  }

  // Mirror mutation error into the inline box. Reply is NOT
  // optimistic, so the user can hit the inline error and retry
  // without waiting for a re-fetch.
  useEffect(() => {
    if (reply.error) {
      // A mutation failure is toast-owned (the hook's onError), so the inline
      // mirror stays visual-only and never double-announces.
      setInlineErrorIsLocal(false);
      // The ledger persistence-failure marker is retry-blocking: the row never
      // became `reconcile_pending`, so the same key must not be retried.
      if (isPrOperationPersistenceFailed(reply.error)) {
        setInlineError(i18n.t('prReview.operation.persistenceFailed'));
        setInlineErrorKind('bad-request');
        return;
      }
      const classification = classifyPrReviewMutationError(reply.error);
      if (isPrOperationAmbiguous(reply.error)) {
        // The effect may have committed: tell the user to verify the PR
        // instead of showing the generic retryable copy. Retry stays enabled.
        setInlineError(i18n.t('prReview.operation.ambiguous'));
        setInlineErrorKind('retryable');
        return;
      }
      if (classification.kind === 'terms-required') {
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
        setInlineError(t('prReview.discussion.replyBadRequest'));
        setInlineErrorKind('bad-request');
      } else if (classification.kind === 'forbidden') {
        // The provider arm words the refusal after the connected provider
        // (merge request vs pull request); GitHub keeps the exact pre-s6 copy.
        setInlineError(
          providerPlatform
            ? t('prReview.discussion.replyForbiddenTerm', {
                term: t(providerPrNounKey(providerPlatform)),
              })
            : t('prReview.discussion.replyForbidden')
        );
        setInlineErrorKind('forbidden');
      } else if (classification.kind === 'reconnect') {
        setInlineError(t('prReview.connectionExpired'));
        setInlineErrorKind('reconnect');
      } else {
        // A generic/transient failure shows the specified retryable copy,
        // never the raw provider error (uxs3 spot check, e6-offline-banner:
        // the same leak as the composer). The draft stays intact and the
        // Reply button stays enabled for the retry.
        setInlineError(t('prReview.operation.couldNotReply'));
        setInlineErrorKind('retryable');
      }
    }
  }, [reply.error, t, providerPlatform]);

  const submit = async () => {
    const body = bodyRef.current.trim();
    if (reply.isPending) {
      return;
    }
    // Empty body is a local validation failure: surface it inline (same copy
    // as the conversation-comment composer) instead of silently no-opping
    // behind an enabled Reply button. Typing clears it via onChangeText.
    if (!body) {
      setInlineError(t('prReview.composer.bodyEmpty'));
      setInlineErrorKind('bad-request');
      setInlineErrorIsLocal(true);
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
    setInlineErrorIsLocal(false);
    // Confirmed offline: fail the submit at once with the retryable copy
    // instead of starting a request that hangs on the UI deadline behind a
    // spinner (uxs3 spot check, e6-offline-hang). The draft stays intact,
    // nothing is pending, and the same tap retries once the banner clears.
    if (getCommittedConnectivityStatus() === 'offline') {
      setInlineError(t('prReview.operation.couldNotReply'));
      setInlineErrorKind('retryable');
      return;
    }
    const outcome = await ensureTermsAcceptedOutcome();
    if (outcome.kind === 'outdated') {
      setInlineError(t('prReview.discussion.termsOutdatedCopy'));
      setInlineErrorKind('bad-request');
      return;
    }
    if (outcome.kind === 'dismissed') {
      return;
    }
    reply.mutate(
      // The provider arm posts the seam vars; the mutation hook routes the
      // call by the live provider scope, so the ids here are provider-native
      // (discussion id / root-comment id), never GitHub's numeric comment id.
      provider
        ? { threadId: provider.threadId, commentNodeId: provider.commentNodeId, body }
        : { owner, repo, number, commentId, body },
      {
        onSuccess: () => {
          bodyRef.current = '';
          if (userId) {
            void clearDraft(userId, replyDraftKey);
          }
          setResetKey(prev => prev + 1);
        },
      }
    );
  };

  return (
    <View className="gap-2">
      {draft.settled ? (
        <TextInput
          key={resetKey}
          ref={inputRef}
          defaultValue={bodyRef.current}
          editable={!reply.isPending}
          placeholder={t('prReview.discussion.replyPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={t('prReview.discussion.replyBody')}
          onFocus={onInputFocus}
          onChangeText={value => {
            bodyRef.current = value;
            if (userId) {
              saveDraft(userId, replyDraftKey, value);
            }
            if (inlineError) {
              setInlineError(null);
              setInlineErrorKind(null);
              setInlineErrorIsLocal(false);
            }
          }}
          multiline
          textAlignVertical="top"
          className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground"
        />
      ) : null}
      {inlineError && inlineErrorKind !== 'reconnect' ? (
        inlineErrorIsLocal ? (
          // The local empty-body reject has no toast owner, so it announces
          // through AccessibleStatus (polite live region / iOS imperative
          // announce), mirroring the conversation-comment composer.
          <AccessibleStatus message={inlineError} tone="error" className="text-xs" />
        ) : (
          <Text className="text-xs text-destructive">{inlineError}</Text>
        )
      ) : null}
      {inlineErrorKind === 'reconnect' ? <PrReviewReconnectNotice /> : null}
      <View className="flex-row justify-end">
        <Button
          size="sm"
          variant="outline"
          loading={reply.isPending}
          disabled={
            !draft.settled ||
            reply.isPending ||
            inlineErrorKind === 'bad-request' ||
            inlineErrorKind === 'forbidden' ||
            inlineErrorKind === 'reconnect'
          }
          onPress={() => {
            void submit();
          }}
          accessibilityLabel={t('prReview.discussion.submitReply')}
        >
          <Text>{t('common.reply')}</Text>
        </Button>
      </View>
    </View>
  );
}
