import { ChatMarkdownText } from './chat-markdown-text';

type TextPartRendererProps = {
  text: string;
};

export function TextPartRenderer({ text }: Readonly<TextPartRendererProps>) {
  if (!text) {
    return null;
  }

  // selectable={false}: the message Pressable's long-press copy sheet and iOS
  // native text selection would both trigger on the same gesture otherwise.
  return <ChatMarkdownText value={text} variant="assistant" selectable={false} />;
}
