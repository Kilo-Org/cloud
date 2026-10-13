import { useState } from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { RenameModal } from '@/components/rename-modal';
import { Text } from '@/components/ui/text';
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/chat/store';

import { BetaPill } from './beta-pill';

type ChatTitleProps = {
  title: string;
  initialValue: string;
  canRename: boolean;
  onRename: (name: string) => Promise<void>;
};

export function ChatTitle({ title, initialValue, canRename, onRename }: Readonly<ChatTitleProps>) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('modelChat.rename.accessibility', { title })}
        disabled={!canRename}
        onPress={() => {
          setRenaming(true);
        }}
        className="shrink flex-row items-center gap-2 active:opacity-70"
      >
        <Text className="shrink text-lg font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <BetaPill />
      </Pressable>
      {renaming ? (
        <RenameModal
          title={t('modelChat.rename.title')}
          placeholder={t('chat.conversation.renamePlaceholder')}
          initialValue={initialValue}
          maxLength={CHAT_TITLE_MAX_LENGTH}
          onSave={onRename}
          onClose={() => {
            setRenaming(false);
          }}
        />
      ) : null}
    </>
  );
}
