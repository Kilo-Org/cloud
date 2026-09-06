import { Text } from '@/components/ui/text';

import { ChatMarkdownText } from '../agents/chat-markdown-text';
import { isMessageTextSelectionEnabled, textBlockHasVisibleContent } from './message-presentation';

type MessageMarkdownProps = {
  text: string;
  isFromMe: boolean;
};

export function MessageMarkdown({ text, isFromMe }: Readonly<MessageMarkdownProps>) {
  if (!textBlockHasVisibleContent(text)) {
    return null;
  }

  try {
    return (
      <ChatMarkdownText
        value={text}
        variant={isFromMe ? 'kilo-chat-user' : 'assistant'}
        selectable={isMessageTextSelectionEnabled()}
      />
    );
  } catch {
    return (
      <Text
        selectable={isMessageTextSelectionEnabled()}
        className={
          isFromMe
            ? 'text-sm leading-5 text-primary-foreground'
            : 'text-sm leading-5 text-foreground'
        }
      >
        {text}
      </Text>
    );
  }
}
