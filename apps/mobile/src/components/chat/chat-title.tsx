import { useState } from 'react';
import { type LayoutChangeEvent, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { RenameModal } from '@/components/rename-modal';
import { Text } from '@/components/ui/text';
import { HEADER_TITLE_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { titleKeepsNotice } from '@/lib/chat/chat-title-notice';
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/chat/store';
import { cn } from '@/lib/utils';

import { BetaPill } from './beta-pill';

type ChatTitleProps = {
  title: string;
  initialValue: string;
  canRename: boolean;
  onRename: (name: string) => Promise<void>;
};

/**
 * The chat's name in the header, and the notice that the chat is unfinished
 * beside it.
 *
 * The name is the screen's identity and the notice is a label about it, so the
 * notice yields first: on a narrow header the pair does not fit together, and
 * the shared row gave the notice its full width while the name shrank to "C…"
 * (measured on the 360dp design-gate cell: 76.19dp of room against 82.04dp of
 * content). Nothing else in the row gives way, and the name is what a person
 * reads to know which screen they are on.
 *
 * The fit is decided from measured widths, never from a breakpoint: the notice
 * is localized (`Beta`, `Bèta`, `Бета`, `베타`), so its width is whatever the
 * active catalog lays out. The measurement comes from a transparent copy that
 * holds no room, and the visible notice starts out absent, so the first frame
 * never squeezes the name to make space for a notice that has not been measured
 * yet. The name measured without the notice is its natural width until the name
 * alone fills the row, where it reports the row: that case fails every fit test
 * and keeps the whole row for the name.
 */
export function ChatTitle({ title, initialValue, canRename, onRename }: Readonly<ChatTitleProps>) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  // The room the header gives the name and its notice, the name's own width, and
  // the notice's own width. Each is a measured layout width; a name longer than
  // its room reports the room, so it fails every fit test and keeps that room
  // for itself before either the name or the notice truncates.
  const [slotWidth, setSlotWidth] = useState<number | null>(null);
  const [titleWidth, setTitleWidth] = useState<number | null>(null);
  const [noticeWidth, setNoticeWidth] = useState<number | null>(null);

  const showNotice =
    slotWidth !== null &&
    titleWidth !== null &&
    noticeWidth !== null &&
    titleKeepsNotice({ slot: slotWidth, title: titleWidth, notice: noticeWidth });

  const measure =
    (accept: (width: number) => void) =>
    (event: LayoutChangeEvent): void => {
      accept(event.nativeEvent.layout.width);
    };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('modelChat.rename.accessibility', { title })}
        disabled={!canRename}
        onPress={() => {
          setRenaming(true);
        }}
        onLayout={measure(setSlotWidth)}
        className={cn(
          HEADER_TITLE_TARGET_CLASS,
          'shrink flex-row items-center gap-2 active:opacity-70'
        )}
      >
        <Text
          className="shrink text-lg font-semibold text-foreground"
          numberOfLines={1}
          onLayout={measure(setTitleWidth)}
        >
          {title}
        </Text>
        {showNotice ? <BetaPill /> : null}
        {/* The notice's own width, measured without holding any of the row: an
            absolute, transparent copy draws nothing and takes no space, so the
            name keeps the whole slot until the measurement decides the notice.
            It is always mounted, so the measurement cannot lag behind a notice
            that has already been shown. */}
        <View
          className="absolute opacity-0"
          pointerEvents="none"
          aria-hidden
          onLayout={measure(setNoticeWidth)}
        >
          <BetaPill />
        </View>
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
