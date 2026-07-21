// Reply input for a single review thread. The input is uncontrolled
// (iOS ref pattern) per the repo's iOS rule. Submit calls the
// (non-optimistic) reply mutation and re-fetches the list on settle.

import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { type useReplyToCommentMutation } from '@/lib/pr-review/discussion/use-review-discussion-mutations';

const REPLY_PLACEHOLDER = 'Reply…';

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
      const classification = classifyPrReviewMutationError(reply.error);
      if (classification.kind === 'bad-request') {
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

  const submit = () => {
    const body = bodyRef.current.trim();
    if (!body || reply.isPending) {
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
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
          onPress={submit}
          accessibilityLabel="Submit reply"
        >
          <Text>Reply</Text>
        </Button>
      </View>
    </View>
  );
}
