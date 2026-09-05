import { useActionSheet } from '@expo/react-native-action-sheet';
import * as Haptics from 'expo-haptics';
import { Alert, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionRow } from '@/components/ui/session-row';
import { type ChatSummary } from '@/lib/chat/store';
import { useChatStatus } from '@/lib/chat/use-chat';
import { timeAgo } from '@/lib/utils';

/**
 * One chat in the list.
 *
 * It is the row every other list in the app uses, so a chat looks like a
 * session: the model names the row and colours its strip, an answer still
 * arriving shows the same live dot a running session does, and the title is
 * the first thing the person said — a chat has no name of its own, and one
 * with nothing said in it yet is the single case that needs a word instead.
 */

type ChatRowProps = {
  chat: ChatSummary;
  modelName: string;
  /** Last of the list, which drops the divider under it. */
  last: boolean;
  onPress: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
};

export function ChatRow({ chat, modelName, last, onPress, onDelete }: Readonly<ChatRowProps>) {
  const { t } = useTranslation();
  // The answer may be arriving on another screen: the chat says so, not the row.
  const working = useChatStatus(chat.sessionId) === 'working';
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const title = chat.title === '' ? t('modelChat.list.untitled') : chat.title;
  const label = modelName === '' ? t('modelChat.title') : modelName;

  function confirmDelete() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(t('modelChat.list.deleteTitle'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('modelChat.list.delete'),
        style: 'destructive',
        onPress: () => {
          onDelete(chat.sessionId);
        },
      },
    ]);
  }

  function openActions() {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        title,
        options: [t('modelChat.list.delete'), t('common.cancel')],
        cancelButtonIndex: 1,
        destructiveButtonIndex: 0,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          confirmDelete();
        }
      }
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={t('modelChat.list.openHint')}
      className="active:opacity-70"
      onPress={() => {
        onPress(chat.sessionId);
      }}
      onLongPress={openActions}
    >
      <SessionRow
        agentLabel={label}
        title={title}
        meta={timeAgo(new Date(chat.updatedAt))}
        live={working}
        metaWhileLive
        last={last}
        stripMode="inline"
        className="pl-[22px] pr-[22px]"
      />
    </Pressable>
  );
}
