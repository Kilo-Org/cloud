import { Text } from '@/components/ui/text';

import { ChatMarkdownText } from '../agents/chat-markdown-text';
import { isMessageTextSelectionEnabled, textBlockHasVisibleContent } from './message-presentation';

type MessageMarkdownProps = {
  text: string;
  isFromMe: boolean;
  /**
   * Render-cache scope for the markdown, so identical message text in another
   * message never reuses the cached elements whose handlers close over a
   * specific message.
   */
  renderScope?: string;
  /**
   * Long-press handler forwarded into rendered code fences' copy trigger so a
   * press-and-hold on a fence still opens the bubble's message actions.
   */
  onLongPressCode?: () => void;
};

export function MessageMarkdown({
  text,
  isFromMe,
  renderScope,
  onLongPressCode,
}: Readonly<MessageMarkdownProps>) {
  if (!textBlockHasVisibleContent(text)) {
    return null;
  }

  try {
    return (
      <ChatMarkdownText
        value={text}
        variant={isFromMe ? 'kilo-chat-user' : 'assistant'}
        selectable={isMessageTextSelectionEnabled()}
        renderScope={renderScope}
        onLongPressCode={onLongPressCode}
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
