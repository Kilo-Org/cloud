import { hasNonWhitespaceText } from './part-types';
import { ChatMarkdownText } from './chat-markdown-text';

type TextPartRendererProps = {
  text: string;
  /**
   * Render-cache scope for this text's markdown, so identical text in another
   * message never reuses the cached elements whose handlers close over a
   * specific message. Omitted outside a message bubble.
   */
  renderScope?: string;
  /**
   * Long-press handler forwarded into rendered code fences' copy trigger so a
   * press-and-hold on a fence still opens message details. Omitted outside a
   * message bubble.
   */
  onLongPressCode?: () => void;
};

export function TextPartRenderer({
  text,
  renderScope,
  onLongPressCode,
}: Readonly<TextPartRendererProps>) {
  if (!hasNonWhitespaceText(text)) {
    return null;
  }

  // selectable={false}: the message Pressable's long-press copy sheet and iOS
  // native text selection would both trigger on the same gesture otherwise.
  return (
    <ChatMarkdownText
      value={text}
      variant="assistant"
      selectable={false}
      renderScope={renderScope}
      onLongPressCode={onLongPressCode}
    />
  );
}
