import { BookOpen } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { ChatMarkdownText } from './chat-markdown-text';
import { MarkdownViewerModal } from './markdown-viewer-modal';
import { type MarkdownPreview } from './read-tool-markdown';
import { getFilename } from './tool-card-utils';

export function ReadMarkdownPreview({ preview }: Readonly<{ preview: MarkdownPreview }>) {
  const textSelectable = useTranscriptTextSelectable();
  const colors = useThemeColors();
  const [readerVisible, setReaderVisible] = useState(false);

  if (preview.text === '') {
    return <Text className="text-xs text-muted-foreground">This file is empty.</Text>;
  }

  return (
    <View className="gap-1">
      <ChatMarkdownText value={preview.inlineText} selectable={textSelectable} />
      {preview.footer ? (
        <Text className="text-xs text-muted-foreground">{preview.footer}</Text>
      ) : null}
      {preview.inlineTruncated ? (
        <Pressable
          onPress={() => {
            setReaderVisible(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Read ${getFilename(preview.path)} in full`}
          className="flex-row items-center gap-1.5 self-start rounded-md bg-neutral-100 px-2.5 py-1.5 active:opacity-70 dark:bg-neutral-900"
        >
          <BookOpen size={14} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">Read full file</Text>
        </Pressable>
      ) : null}
      <MarkdownViewerModal
        visible={readerVisible}
        path={preview.path}
        value={preview.text}
        footer={preview.footer}
        onClose={() => {
          setReaderVisible(false);
        }}
      />
    </View>
  );
}
