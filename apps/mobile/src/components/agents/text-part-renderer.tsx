import { ChatMarkdownText } from './chat-markdown-text';

type TextPartRendererProps = {
  text: string;
  /**
   * Long-press handler forwarded into rendered code fences' copy trigger so a
   * press-and-hold on a fence still opens message details. Omitted outside a
   * message bubble.
   */
  onLongPressCode?: () => void;
};

export function TextPartRenderer({ text, onLongPressCode }: Readonly<TextPartRendererProps>) {
  if (!text.trim()) {
    return null;
  }

  // selectable={false}: the message Pressable's long-press copy sheet and iOS
  // native text selection would both trigger on the same gesture otherwise.
  return (
    <ChatMarkdownText
      value={text}
      variant="assistant"
      selectable={false}
      onLongPressCode={onLongPressCode}
    />
  );
}
