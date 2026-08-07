import { View } from 'react-native';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { ChatMarkdownText } from './chat-markdown-text';
import { type MarkdownBody } from './read-tool-markdown';

/**
 * Full markdown body of a read tool part, rendered directly in the detail sheet.
 * The sheet scrolls, so the complete file renders here — no inline cap, no nested
 * full-screen reader.
 */
export function ReadMarkdownBody({ body }: Readonly<{ body: MarkdownBody }>) {
  const textSelectable = useTranscriptTextSelectable();

  if (body.text === '') {
    return <Text className="text-xs text-muted-foreground">This file is empty.</Text>;
  }

  return (
    <View className="gap-1">
      <ChatMarkdownText value={body.text} selectable={textSelectable} />
      {body.footer ? <Text className="text-xs text-muted-foreground">{body.footer}</Text> : null}
    </View>
  );
}
