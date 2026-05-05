import { Text } from '@/components/ui/text';

import { MarkdownText } from '../agents/markdown-text';
import { isMessageTextSelectionEnabled } from './message-presentation';

type MessageMarkdownProps = {
  text: string;
  isFromMe: boolean;
};

export function MessageMarkdown({ text, isFromMe }: Readonly<MessageMarkdownProps>) {
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return (
      <MarkdownText
        value={text}
        variant={isFromMe ? 'user' : 'assistant'}
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
