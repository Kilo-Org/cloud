import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';

import { ChatMarkdownText } from './chat-markdown-text';
import { MarkdownViewerModal } from './markdown-viewer-modal';
import { type MarkdownPreview } from './read-tool-markdown';
import { getFilename } from './tool-card-utils';

export function ReadMarkdownPreview({ preview }: Readonly<{ preview: MarkdownPreview }>) {
  const [readerVisible, setReaderVisible] = useState(false);

  if (preview.text === '') {
    return <Text className="text-xs text-muted-foreground">This file is empty.</Text>;
  }

  return (
    <View className="gap-1">
      <Pressable
        onPress={() => {
          setReaderVisible(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Open ${getFilename(preview.path)} full screen`}
        className="active:opacity-80"
      >
        <ChatMarkdownText value={preview.inlineText} />
      </Pressable>
      {preview.footer ? (
        <Text className="text-xs text-muted-foreground">{preview.footer}</Text>
      ) : null}
      {preview.inlineTruncated ? (
        <Text className="text-xs text-muted-foreground">Tap to read the full file</Text>
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
