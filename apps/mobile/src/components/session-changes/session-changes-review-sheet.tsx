// The collected review: every comment the reader saved, in one place, with the
// one action that sends them to the agent as a single message.

import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
import {
  type SessionChangesDraft,
  type SessionChangesReviewBlock,
} from '@/lib/session-changes-review';

function CommentRow({
  path,
  line,
  quote,
  text,
  onRemove,
}: Readonly<{
  path: string;
  line: number;
  quote: string;
  text: string;
  onRemove: () => void;
}>) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 border-b border-hair-soft py-3">
      <Text variant="muted" className="text-xs" numberOfLines={2}>
        {`${isolateLtrBidiText(path)}:${line}`}
      </Text>
      <Text className="font-mono-medium text-xs text-muted-foreground" numberOfLines={2}>
        {isolateLtrBidiText(quote)}
      </Text>
      <View className="flex-row items-start gap-2">
        <Text className="flex-1 text-sm text-foreground">{text}</Text>
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.sessionChanges.removeComment')}
          className="min-h-[32px] min-w-[32px] items-center justify-center active:opacity-70"
          testID="session-changes-review-remove-comment"
        >
          <Text className="text-xs text-destructive">{t('common.remove')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function SessionChangesReviewSheet({
  visible,
  draft,
  block,
  error,
  sending,
  onClose,
  onSend,
  onDiscard,
  onRemoveComment,
}: Readonly<{
  visible: boolean;
  draft: SessionChangesDraft;
  block: SessionChangesReviewBlock | undefined;
  error: string | undefined;
  sending: boolean;
  onClose: () => void;
  onSend: () => void;
  onDiscard: () => void;
  onRemoveComment: (id: string) => void;
}>) {
  const { t } = useTranslation();
  const sendDisabled = block !== undefined || sending;
  return (
    <Sheet visible={visible} onClose={onClose} dismissGestures={false}>
      <View className="px-4 pb-6">
        <View className="flex-row items-center justify-between gap-3 pb-2">
          <Text className="text-base font-semibold text-foreground">
            {t('agentChat.sessionChanges.reviewTitle', { count: draft.comments.length })}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            className="min-h-[44px] justify-center active:opacity-70"
          >
            <Text variant="muted" className="text-sm">
              {t('common.close')}
            </Text>
          </Pressable>
        </View>
        <Text variant="muted" className="pb-1 text-xs">
          {t('agentChat.sessionChanges.reviewHint')}
        </Text>
        {block === undefined ? null : (
          <Text className="text-xs text-warn" testID="session-changes-review-block">
            {block.kind === 'read-only'
              ? t('agentChat.sessionChanges.readOnlyReason')
              : t('agentChat.sessionChanges.noAgentModelReason')}
          </Text>
        )}
        <ScrollView className="max-h-[320px]" testID="session-changes-review-comments">
          {draft.comments.map(comment => (
            <CommentRow
              key={comment.id}
              path={comment.anchor.path}
              line={comment.anchor.range.startLine}
              quote={comment.anchor.quote.lines.map(line => line.text.trimEnd()).join('\n')}
              text={comment.text}
              onRemove={() => {
                onRemoveComment(comment.id);
              }}
            />
          ))}
        </ScrollView>
        {error === undefined ? null : (
          <Text className="pt-2 text-xs text-destructive">{error}</Text>
        )}
        <View className="flex-row justify-between gap-2 pt-4">
          <Button
            variant="outline"
            onPress={onDiscard}
            disabled={sending}
            testID="session-changes-review-discard"
          >
            <Text>{t('common.discard')}</Text>
          </Button>
          <Button
            onPress={onSend}
            loading={sending}
            disabled={sendDisabled}
            accessibilityLabel={t('agentChat.sessionChanges.sendReview')}
            testID="session-changes-review-send"
          >
            <Text>{t('agentChat.sessionChanges.sendReview')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
