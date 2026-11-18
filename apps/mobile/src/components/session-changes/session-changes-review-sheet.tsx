// The collected review: every comment the reader saved, in one place, with the
// one action that sends them to the agent as a single message.

import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
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
    <View className="gap-1 border-b-[0.5px] border-hair-soft py-3">
      <Text variant="caption" numberOfLines={2}>
        {`${isolateLtrBidiText(path)}:${line}`}
      </Text>
      <Text variant="mono" className="text-muted-foreground" numberOfLines={2}>
        {isolateLtrBidiText(quote)}
      </Text>
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-foreground">{text}</Text>
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.sessionChanges.removeComment')}
          // A text action is as wide as its label, not a square: the 32pt
          // square squeezed "Remove" against its own edges. It keeps the
          // compact height on the spacing scale and takes `px-2` for the label,
          // and the slop lifts the 28pt box to the 44pt touch floor.
          className="h-8 items-center justify-center px-2 active:opacity-70"
          hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
          testID="session-changes-review-remove-comment"
        >
          <Text variant="caption" className="text-destructive">
            {t('common.remove')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function SessionChangesReviewSheet({
  visible,
  draft,
  staleCommentIds,
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
  staleCommentIds: ReadonlySet<string>;
  block: SessionChangesReviewBlock | undefined;
  error: string | undefined;
  sending: boolean;
  onClose: () => void;
  onSend: () => void;
  onDiscard: () => void;
  onRemoveComment: (id: string) => void;
}>) {
  const { t } = useTranslation();
  const sendDisabled = block !== undefined || sending || draft.comments.length === 0;
  return (
    <Sheet visible={visible} onClose={onClose} dismissGestures={false}>
      <SheetHeader
        title={t('agentChat.sessionChanges.reviewTitle', { count: draft.comments.length })}
        onDone={onClose}
        doneLabel={t('common.close')}
        underHandle
      />
      <View className="px-4 pb-6">
        <Text variant="caption" className="pb-1">
          {t('agentChat.sessionChanges.reviewHint')}
        </Text>
        {staleCommentIds.size === 0 ? null : (
          <Text variant="caption" className="text-warn" testID="session-changes-review-stale">
            {t('agentChat.sessionChanges.staleFile')}
          </Text>
        )}
        {block === undefined ? null : (
          <Text variant="caption" className="text-warn" testID="session-changes-review-block">
            {block.kind === 'read-only'
              ? t('agentChat.sessionChanges.readOnlyReason')
              : t('agentChat.sessionChanges.noAgentModelReason')}
          </Text>
        )}
        <ScrollView className="max-h-96" testID="session-changes-review-comments">
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
          <Text variant="caption" className="pt-2 text-destructive">
            {error}
          </Text>
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
