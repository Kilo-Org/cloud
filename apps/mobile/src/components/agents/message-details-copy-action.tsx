import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { useMessageDetailsCopyFeedback } from './message-details-copy';

/**
 * The Copy pressable and its feedback line, as one block. The sheet mounts it
 * with a `key` per message and per visibility, so a new message or a reopen
 * starts from the call to action instead of inheriting the previous outcome.
 */
export function DetailsCopyAction({ copyText }: Readonly<{ copyText: string }>) {
  const { t } = useTranslation();
  const copy = useMessageDetailsCopyFeedback();
  return (
    <View className="gap-2">
      <Pressable
        onPress={() => {
          copy.handleCopy(copyText);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.messageDetails.copyMessage')}
        className="rounded-md border border-border px-4 py-3 active:opacity-70"
        testID="message-details-copy"
      >
        <Text className="text-center text-base font-medium text-foreground">
          {t('agentChat.messageDetails.copyMessage')}
        </Text>
      </Pressable>
      {copy.status ? (
        <Text
          className={cn(
            'text-center text-sm',
            copy.feedback.status === 'failed' ? 'text-destructive' : 'text-foreground'
          )}
          testID="message-details-copy-feedback"
        >
          {copy.status}
        </Text>
      ) : null}
    </View>
  );
}
