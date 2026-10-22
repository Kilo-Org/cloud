import { useActionSheet } from '@expo/react-native-action-sheet';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { RenameModal } from '@/components/rename-modal';
import { useConfirmDialog } from '@/components/ui/dialog';
import { SessionRow } from '@/components/ui/session-row';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import { CHAT_TITLE_MAX_LENGTH, type ChatSummary } from '@/lib/chat/store';
import { useChatStatus } from '@/lib/chat/use-chat';
import { timeAgo } from '@/lib/utils';

/**
 * One chat in the list.
 *
 * It is the row every other list in the app uses, so a chat looks like a
 * session: the model names the row and colours its strip, an answer still
 * arriving shows the same live dot a running session does, and the title is
 * the name the person gave the chat, else the first thing they said — one
 * with nothing said in it yet is the single case that needs a word instead.
 */

type ChatRowProps = {
  chat: ChatSummary;
  modelName: string;
  /** Last of the list, which drops the divider under it. */
  last: boolean;
  onPress: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
};

export function ChatRow({
  chat,
  modelName,
  last,
  onPress,
  onDelete,
  onRename,
}: Readonly<ChatRowProps>) {
  const { t } = useTranslation();
  // The answer may be arriving on another screen: the chat says so, not the row.
  const working = useChatStatus(chat.sessionId) === 'working';
  const { showActionSheetWithOptions } = useActionSheet();
  const themedSheet = useThemedActionSheetOptions();
  const { confirm, dialog } = useConfirmDialog();
  const [renaming, setRenaming] = useState(false);
  const title = chat.title === '' ? t('chat.conversation.untitled') : chat.title;
  const label = modelName === '' ? t('common.chat') : modelName;
  // Two chats opened from the same first message share a title. The newest
  // message in each tells them apart, and repeating one that is already the
  // title would say nothing.
  const preview = chat.preview.trim() === chat.title.trim() ? '' : chat.preview;

  function confirmDelete() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    confirm({
      title: t('modelChat.list.deleteTitle'),
      message: title,
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        onDelete(chat.sessionId);
      },
    });
  }

  function openActions() {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        ...themedSheet,
        title,
        options: [t('common.rename'), t('common.delete'), t('common.cancel')],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
      },
      index => {
        if (index === 0) {
          setRenaming(true);
        } else if (index === 1) {
          confirmDelete();
        }
      }
    );
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={t('modelChat.rename.openHint')}
        className="active:opacity-70"
        onPress={() => {
          onPress(chat.sessionId);
        }}
        onLongPress={openActions}
      >
        <SessionRow
          agentLabel={label}
          title={title}
          subtitle={preview}
          subtitleVariant="default"
          meta={timeAgo(new Date(chat.updatedAt))}
          live={working}
          metaWhileLive
          last={last}
          stripMode="inline"
          className="pl-[22px] pr-[22px]"
        />
      </Pressable>
      {dialog}
      {renaming ? (
        <RenameModal
          title={t('modelChat.rename.title')}
          placeholder={t('chat.conversation.renamePlaceholder')}
          initialValue={chat.title}
          maxLength={CHAT_TITLE_MAX_LENGTH}
          onSave={async name => {
            await onRename(chat.sessionId, name);
          }}
          onClose={() => {
            setRenaming(false);
          }}
        />
      ) : null}
    </>
  );
}
