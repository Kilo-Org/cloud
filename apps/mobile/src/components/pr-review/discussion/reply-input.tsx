// Reply input for a single review thread. The input is uncontrolled
// (iOS ref pattern) per the repo's iOS rule. Submit calls the
// (non-optimistic) reply mutation and re-fetches the list on settle.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { UGC_AGE_POSTURE } from '@kilocode/app-shared/moderation';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearDraft, prReplyDraftKey, saveDraft } from '@/lib/persist/drafts';
import { useDraftFlushOnBackground } from '@/lib/persist/use-draft-flush';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import {
  isPrOperationPersistenceFailed,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';
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
              void WebBrowser.openBrowserAsync(`${WEB_BASE_URL}/terms-app`);
              show();
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
};

export function ReplyInput({ owner, repo, number, commentId, reply }: Readonly<ReplyInputProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const bodyRef = useRef<string>('');
  const inputRef = useRef<TextInput | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);
  const [resetKey, setResetKey] = useState(0);

  // Durable reply draft, keyed by account and thread. Nothing is saved or
  // restored while the user id is unknown.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const replyDraftKey = prReplyDraftKey(owner, repo, number, commentId);
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
      // The ledger persistence-failure marker is retry-blocking: the row never
      // became `reconcile_pending`, so the same key must not be retried.
      if (isPrOperationPersistenceFailed(reply.error)) {
        setInlineError(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
        setInlineErrorKind('bad-request');
        return;
      }
      const classification = classifyPrReviewMutationError(reply.error);
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
        setInlineError(t('prReview.discussion.replyForbidden'));
        setInlineErrorKind('forbidden');
      } else if (classification.kind === 'reconnect') {
        setInlineError(t('prReview.connectionExpired'));
        setInlineErrorKind('reconnect');
      } else {
        const message =
          reply.error instanceof Error
            ? reply.error.message
            : t('prReview.discussion.couldNotReply');
        setInlineError(message);
        setInlineErrorKind('retryable');
      }
    }
  }, [reply.error, t]);

  const submit = async () => {
    const body = bodyRef.current.trim();
    if (!body || reply.isPending) {
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
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
      { owner, repo, number, commentId, body },
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
          onChangeText={value => {
            bodyRef.current = value;
            if (userId) {
              saveDraft(userId, replyDraftKey, value);
            }
            if (inlineError) {
              setInlineError(null);
              setInlineErrorKind(null);
            }
          }}
          multiline
          textAlignVertical="top"
          className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground"
        />
      ) : null}
      {inlineError && inlineErrorKind !== 'reconnect' ? (
        <Text className="text-xs text-destructive">{inlineError}</Text>
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
          <Text>{t('prReview.discussion.reply')}</Text>
        </Button>
      </View>
    </View>
  );
}
