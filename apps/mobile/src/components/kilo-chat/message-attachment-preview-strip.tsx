import { ScrollView } from 'react-native';
import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';

import { MessageAttachmentPreviewChip } from './message-attachment-preview-chip';

type Props = {
  rows: QueuedAttachment[];
  getLocalUri: (tempId: string) => string | null;
  onRemove: (tempId: string) => void;
  onRetry?: (tempId: string) => void;
};

export function MessageAttachmentPreviewStrip({ rows, getLocalUri, onRemove, onRetry }: Props) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-2"
      contentContainerClassName="items-center"
      keyboardShouldPersistTaps="handled"
    >
      {rows.map(row => (
        <MessageAttachmentPreviewChip
          key={row.tempId}
          row={row}
          localUri={getLocalUri(row.tempId)}
          onRemove={() => {
            onRemove(row.tempId);
          }}
          onRetry={() => {
            onRetry?.(row.tempId);
          }}
        />
      ))}
    </ScrollView>
  );
}
