// The comment composer for one diff line: a card with a multiline field and the
// add/save action. Dismissing keeps the draft comment list untouched.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { MAX_WORKTREE_REVIEW_COMMENT_LENGTH } from '@kilocode/app-shared/worktree-review';

export function SessionChangesCommentDialog({
  visible,
  path,
  line,
  initialText,
  onCancel,
  onSubmit,
}: Readonly<{
  visible: boolean;
  path: string;
  line: number;
  initialText: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}>) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);

  useEffect(() => {
    if (visible) {
      setText(initialText);
    }
  }, [visible, initialText]);

  if (!visible) {
    return null;
  }
  const trimmed = text.trim();
  const tooLong = text.length > MAX_WORKTREE_REVIEW_COMMENT_LENGTH;
  return (
    <DialogCard onClose={onCancel}>
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">
          {t('agentChat.sessionChanges.commentOnLine', { line })}
        </Text>
        <Text variant="muted" className="text-xs" numberOfLines={2}>
          {path}
        </Text>
      </View>
      <Input
        multiline
        numberOfLines={4}
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder={t('agentChat.sessionChanges.commentPlaceholder')}
        accessibilityLabel={t('prReview.composer.commentBody')}
        className="min-h-[96px] text-base"
        testID="session-changes-comment-input"
      />
      {tooLong ? (
        <Text className="text-xs text-destructive">
          {t('agentChat.sessionChanges.commentTooLong', {
            max: MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
          })}
        </Text>
      ) : null}
      <View className="flex-row justify-end gap-2">
        <Button variant="outline" onPress={onCancel} testID="session-changes-comment-cancel">
          <Text>{t('common.cancel')}</Text>
        </Button>
        <Button
          disabled={trimmed.length === 0 || tooLong}
          onPress={() => {
            onSubmit(text);
          }}
          testID="session-changes-comment-save"
        >
          <Text>{t('prReview.composer.addTitle')}</Text>
        </Button>
      </View>
    </DialogCard>
  );
}
