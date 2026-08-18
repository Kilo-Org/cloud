// Reply input for a single review thread. The input is uncontrolled
// (iOS ref pattern) per the repo's iOS rule. Submit calls the
// (non-optimistic) reply mutation and re-fetches the list on settle.

import { useEffect, useRef, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { UGC_AGE_POSTURE } from '@kilocode/app-shared/moderation';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import {
  isPrOperationPersistenceFailed,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import { trpcClient } from '@/lib/trpc';

const REPLY_PLACEHOLDER = 'Reply…';

const TERMS_COPY = 'You must be 13 or older to post.';

/**
 * Best-effort UGC Terms gate. Returns true when the current version is
 * already accepted, or when the user accepts now. Returns false when the
 * user dismisses the gate. A `getTermsStatus` failure passes through (the
 * server enforces Terms on the write and the reactive path re-prompts).
 */
export async function ensureTermsAccepted(): Promise<boolean> {
  try {
    const status = await trpcClient.moderation.getTermsStatus.query();
    if (status.accepted) {
      return true;
    }
    return await promptTermsAcceptance(status.currentVersion);
  } catch {
    return true;
  }
}

async function promptTermsAcceptance(version: string): Promise<boolean> {
  const accepted = await new Promise<boolean>(resolve => {
    const show = () => {
      Alert.alert('Terms of Service', TERMS_COPY, [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            resolve(false);
          },
        },
        {
          text: 'View terms',
          onPress: () => {
            void WebBrowser.openBrowserAsync(`${WEB_BASE_URL}/terms-app`);
            show();
          },
        },
        {
          text: 'Accept',
          onPress: () => {
            void (async () => {
              try {
                await trpcClient.moderation.acceptTerms.mutate({
                  version,
                  agePosture: UGC_AGE_POSTURE,
                });
                resolve(true);
              } catch {
                resolve(false);
              }
            })();
          },
        },
      ]);
    };
    show();
  });
  return accepted;
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
  const bodyRef = useRef<string>('');
  const inputRef = useRef<TextInput | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'bad-request' | 'forbidden' | 'reconnect' | null
  >(null);
  const [resetKey, setResetKey] = useState(0);

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
          const accepted = await ensureTermsAccepted();
          if (accepted) {
            setInlineError(null);
          } else {
            setInlineError(TERMS_COPY);
          }
          setInlineErrorKind(null);
        })();
      } else if (classification.kind === 'bad-request') {
        setInlineError("This reply can't be posted. The thread may have changed.");
        setInlineErrorKind('bad-request');
      } else if (classification.kind === 'forbidden') {
        setInlineError("You don't have permission to reply to this pull request.");
        setInlineErrorKind('forbidden');
      } else if (classification.kind === 'reconnect') {
        setInlineError('GitHub connection expired.');
        setInlineErrorKind('reconnect');
      } else {
        const message = reply.error instanceof Error ? reply.error.message : 'Could not reply.';
        setInlineError(message);
        setInlineErrorKind('retryable');
      }
    }
  }, [reply.error]);

  const submit = async () => {
    const body = bodyRef.current.trim();
    if (!body || reply.isPending) {
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
    const accepted = await ensureTermsAccepted();
    if (!accepted) {
      return;
    }
    reply.mutate(
      { owner, repo, number, commentId, body },
      {
        onSuccess: () => {
          bodyRef.current = '';
          setResetKey(prev => prev + 1);
        },
      }
    );
  };

  return (
    <View className="gap-2">
      <TextInput
        key={resetKey}
        ref={inputRef}
        defaultValue=""
        editable={!reply.isPending}
        placeholder={REPLY_PLACEHOLDER}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel="Reply body"
        onChangeText={value => {
          bodyRef.current = value;
          if (inlineError) {
            setInlineError(null);
            setInlineErrorKind(null);
          }
        }}
        multiline
        textAlignVertical="top"
        className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground"
      />
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
            reply.isPending ||
            inlineErrorKind === 'bad-request' ||
            inlineErrorKind === 'forbidden' ||
            inlineErrorKind === 'reconnect'
          }
          onPress={() => {
            void submit();
          }}
          accessibilityLabel="Submit reply"
        >
          <Text>Reply</Text>
        </Button>
      </View>
    </View>
  );
}
