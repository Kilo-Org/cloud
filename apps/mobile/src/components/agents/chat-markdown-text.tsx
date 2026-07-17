import { useActionSheet } from '@expo/react-native-action-sheet';
import { useCallback } from 'react';
import { type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  buildChatLinkActionSheet,
  getSelectedChatLinkAction,
  performChatLinkAction,
} from './chat-link-actions';
import { MarkdownText, type MarkdownTextProps } from './markdown-text';

type ChatMarkdownTextProps = Omit<MarkdownTextProps, 'onLongPressLink'>;

export function ChatMarkdownText(props: Readonly<ChatMarkdownTextProps>) {
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();

  const handleLongPressLink = useCallback(
    (href: string, event?: GestureResponderEvent) => {
      event?.stopPropagation();
      const sheet = buildChatLinkActionSheet();
      showActionSheetWithOptions(
        {
          options: sheet.options,
          cancelButtonIndex: sheet.cancelButtonIndex,
          title: 'Link actions',
          message: href,
          containerStyle: { paddingBottom: bottom },
        },
        index => {
          const action = getSelectedChatLinkAction(sheet, index);
          if (action) {
            void performChatLinkAction(action, href);
          }
        }
      );
    },
    [bottom, showActionSheetWithOptions]
  );

  return <MarkdownText {...props} onLongPressLink={handleLongPressLink} />;
}
