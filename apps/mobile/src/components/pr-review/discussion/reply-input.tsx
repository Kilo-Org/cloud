// Reply input for a single review thread. The input is uncontrolled
// (iOS ref pattern) per the repo's iOS rule. Submit calls the
// (non-optimistic) reply mutation and re-fetches the list on settle.

import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, TextInput, View } from 'react-native';

import { UGC_AGE_POSTURE } from '@kilocode/app-shared/moderation';

import { ComposerInlineError } from '@/components/pr-review/composer-inline-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { connectionRefusesWrites } from '@/lib/hooks/use-offline-banner-state';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearDraft, clearDraftIfStill, prReplyDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import { classifyPrInlineFailure, type PrInlineFailure } from '@/lib/pr-review/inline-failure';
import { type ProviderPrRef, providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import { trpcClient } from '@/lib/trpc';

/**
 * Outcome of the UGC Terms gate. `accepted` means the current version is
 * already accepted or the user accepted now (the caller may post).
 * `dismissed` means the user cancelled the gate. `outdated` means the accept
 * was rejected because the version is stale — terminal, the caller must not
 * post. `unknown` means the Terms status could not be read, so acceptance is
 * unconfirmed.
 */
export type TermsGateOutcome =
  | { kind: 'accepted' }
  | { kind: 'dismissed' }
  | { kind: 'outdated' }
  | { kind: 'unknown' };

/**
 * Best-effort UGC Terms gate. Returns `accepted` when the current version is
 * already accepted, or when the user accepts now. A transient accept failure
 * re-prompts with a Retry CTA; an outdated-version reject returns `outdated`
 * (terminal). A `getTermsStatus` failure returns `unknown`: the write may still
 * be attempted (the server enforces Terms), but a pending Terms error must stay
 * visible instead of being cleared as if acceptance was confirmed.
 */
export async function ensureTermsAcceptedOutcome(): Promise<TermsGateOutcome> {
  try {
    const status = await trpcClient.moderation.getTermsStatus.query();
    if (status.accepted) {
      return { kind: 'accepted' };
    }
    return await promptTermsAcceptance(status.currentVersion);
  } catch {
    return { kind: 'unknown' };
  }
}

async function promptTermsAcceptance(version: string): Promise<TermsGateOutcome> {
  const outcome = await new Promise<TermsGateOutcome>(resolve => {
    async function accept() {
      try {
        await trpcClient.moderation.acceptTerms.mutate({
          version,
          agePosture: UGC_AGE_POSTURE,
        });
        resolve({ kind: 'accepted' });
      } catch (error) {
        // A BAD_REQUEST reject is the server's stale-version marker: terminal.
        // Anything else (network, 5xx) is transient and re-prompts with Retry.
        if (classifyPrReviewMutationError(error).kind === 'bad-request') {
          resolve({ kind: 'outdated' });
        } else {
          showRetry();
        }
      }
    }
    function showRetry() {
      Alert.alert(
        i18n.t('prReview.discussion.termsTitle'),
        i18n.t('prReview.discussion.termsAcceptRetry'),
        [
          {
            text: i18n.t('common.cancel'),
            style: 'cancel',
            onPress: () => {
              resolve({ kind: 'dismissed' });
            },
          },
          {
            text: i18n.t('common.retry'),
            onPress: () => {
              void accept();
            },
          },
        ],
        { cancelable: false }
      );
    }
    const show = () => {
      Alert.alert(
        i18n.t('prReview.discussion.termsTitle'),
        i18n.t('prReview.discussion.termsCopy'),
        [
          {
            text: i18n.t('common.cancel'),
            style: 'cancel',
            onPress: () => {
              resolve({ kind: 'dismissed' });
            },
          },
          {
            text: i18n.t('prReview.discussion.viewTerms'),
            onPress: () => {
              // The terms render in their own native screen. The dialog closes
              // instead of re-opening over it: the reader returns to the
              // composer and sending again re-enters this gate.
              router.push({ pathname: '/(app)/legal/[document]', params: { document: 'terms' } });
            },
          },
          {
            text: i18n.t('prReview.discussion.acceptTerms'),
            onPress: () => {
              void accept();
            },
          },
        ],
        { cancelable: false }
      );
    };
    show();
  });
  return outcome;
}

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

/** Failure kinds whose recovery lives outside the Reply button. */
const REPLY_BLOCKING = new Set<PrInlineFailure['kind']>([
  'body-empty',
  'bad-request',
  'not-recorded',
  'forbidden',
  'reconnect',
]);

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
  const [resetKey, setResetKey] = useState(0);
  const { feedback, failure, begin, clearWhere } = useSurfaceFeedback<PrInlineFailure>();

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

  const submit = async () => {
    const attempt = begin();
    if (attempt === null) {
      // One reply in flight: the double-tap window is closed.
      return;
    }
    const body = bodyRef.current.trim();
    if (!body) {
      // The family's own validation copy, and a local rejection has no toast
      // owner: it announces through the inline box like the composer's.
      attempt.fail({
        kind: 'body-empty',
        message: t('prReview.composer.bodyEmpty'),
        announce: 'here',
      });
      return;
    }
    // Confirmed offline: fail the submit at once with the retryable copy
    // instead of starting a request that hangs on the UI deadline behind a
    // spinner (uxs3 spot check, e6-offline-hang). The draft stays intact,
    // nothing is pending, and the same tap retries once the banner clears.
    if (connectionRefusesWrites()) {
      attempt.fail({
        kind: 'retryable',
        message: t('prReview.operation.couldNotReply'),
        // A local rejection with no toast owner: the inline box announces it,
        // like the composer's and the edit sheet's own validations.
        announce: 'here',
      });
      return;
    }
    const outcome = await ensureTermsAcceptedOutcome();
    if (!attempt.owns()) {
      // The thread unmounted while the gate ran: this token no longer owns the
      // phase, so nothing may be posted.
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
      await reply.mutateAsync(
        // The provider arm posts the seam vars; the mutation hook routes the
        // call by the live provider scope, so the ids here are provider-native
        // (discussion id / root-comment id), never GitHub's numeric comment id.
        provider
          ? { threadId: provider.threadId, commentNodeId: provider.commentNodeId, body }
          : { owner, repo, number, commentId, body }
      );
      // A departed surface's token is dead: a newer mount owns the key, and the
      // draft it is typing must survive this late success.
      if (!attempt.succeed()) {
        // A newer mount owns the slot: clear only the body this submit posted,
        // so a draft typed after the unmount survives and the posted text does
        // not re-seed the field on the next open.
        if (userId) {
          void clearDraftIfStill(userId, replyDraftKey, JSON.stringify(bodyRef.current));
        }
        return;
      }
      bodyRef.current = '';
      if (userId) {
        void clearDraft(userId, replyDraftKey);
      }
      setResetKey(prev => prev + 1);
    } catch (error) {
      const classified = await classifyPrInlineFailure(error, {
        surface: 'reply',
        ...(provider ? { platform: provider.ref.platform } : {}),
        announce: 'toast',
      });
      if (classified.kind === 'failure') {
        attempt.fail(classified.failure);
      } else {
        attempt.abandon();
      }
    }
  };

  return (
    <View className="gap-2">
      {draft.settled ? (
        <TextInput
          key={resetKey}
          ref={inputRef}
          defaultValue={bodyRef.current}
          editable={feedback.status !== 'pending'}
          placeholder={t('prReview.discussion.replyPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={t('prReview.discussion.replyBody')}
          onFocus={onInputFocus}
          onChangeText={value => {
            bodyRef.current = value;
            if (userId) {
              saveDraft(userId, replyDraftKey, value);
            }
            // An edit retires every standing failure, as the shipped
            // keystroke-clear did.
            clearWhere(() => true);
          }}
          multiline
          textAlignVertical="top"
          className="min-h-16 rounded-md border border-input bg-background pl-3 pr-3 py-2 text-sm leading-[1.25rem] text-foreground"
        />
      ) : null}
      <ComposerInlineError feedback={feedback} />
      <View className="flex-row justify-end">
        <Button
          size="sm"
          variant="outline"
          loading={feedback.status === 'pending'}
          disabled={!draft.settled || (failure !== null && REPLY_BLOCKING.has(failure.kind))}
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
