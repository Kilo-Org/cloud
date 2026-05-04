import { Text } from '@/components/ui/text';

import { MarkdownText } from '../agents/markdown-text';

type MessageMarkdownProps = {
  text: string;
  isFromMe: boolean;
};

export function MessageMarkdown({ text, isFromMe }: Readonly<MessageMarkdownProps>) {
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return <MarkdownText value={text} variant={isFromMe ? 'user' : 'assistant'} />;
  } catch {
    return (
      <Text selectable className="text-sm leading-5 text-foreground">
        {text}
      </Text>
    );
  }
}
