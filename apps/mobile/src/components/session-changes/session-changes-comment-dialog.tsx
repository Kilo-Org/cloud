// The comment composer for one diff line: a card with a multiline field and the
// add/save action. Dismissing keeps the draft comment list untouched.

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { MAX_WORKTREE_REVIEW_COMMENT_LENGTH } from '@kilocode/app-shared/worktree-review';

export function SessionChangesCommentDialog({
  path,
  line,
  initialText,
  editing,
  onCancel,
  onSubmit,
}: Readonly<{
  path: string;
  line: number;
  initialText: string;
  editing: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}>) {
  const { t } = useTranslation();
  // iOS: the field stays uncontrolled (ref + defaultValue). The component is
  // mounted per open, so `defaultValue` reseeds without a state write, and the
  // state below feeds only the derived submit/too-long UI.
  const textRef = useRef(initialText);
  const [length, setLength] = useState(initialText.length);
  const [trimmedLength, setTrimmedLength] = useState(initialText.trim().length);
  const tooLong = length > MAX_WORKTREE_REVIEW_COMMENT_LENGTH;
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
        defaultValue={initialText}
        onChangeText={next => {
          textRef.current = next;
          setLength(next.length);
          setTrimmedLength(next.trim().length);
        }}
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
          disabled={trimmedLength === 0 || tooLong}
          onPress={() => {
            onSubmit(textRef.current);
          }}
          testID="session-changes-comment-save"
        >
          <Text>{editing ? t('common.save') : t('prReview.composer.addTitle')}</Text>
        </Button>
      </View>
    </DialogCard>
  );
}
