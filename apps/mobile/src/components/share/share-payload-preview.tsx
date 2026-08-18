import { formatFileSize } from '@kilocode/kilo-chat';
import { File as FileIcon } from '@/components/ui/icons';
import { ScrollView, View } from 'react-native';

import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import { describeClassificationFailure } from '@/lib/agent-attachments/validate';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SharePayload } from '@/lib/share-payload';

import {
  type AcceptedShareFile,
  type RejectedNote,
  type SharePayloadValidation,
} from './share-payload-validation';

type SharePayloadPreviewProps = {
  payload: SharePayload;
  validation: SharePayloadValidation | null;
};

function PreviewImages({ files }: { files: readonly AcceptedShareFile[] }) {
  const images = files.filter(f => f.kind === 'image').slice(0, 5);
  if (images.length === 0) {
    return null;
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="max-h-16"
      contentContainerClassName="flex-row gap-2"
    >
      {images.map(file => (
        <Image
          key={file.uri}
          source={{ uri: file.uri }}
          className="h-16 w-16 rounded-md bg-muted"
          contentFit="cover"
          transition={0}
          accessibilityLabel={file.name}
        />
      ))}
    </ScrollView>
  );
}

function PreviewDocuments({ files }: { files: readonly AcceptedShareFile[] }) {
  const colors = useThemeColors();
  const documents = files.filter(f => f.kind === 'document');
  if (documents.length === 0) {
    return null;
  }
  return (
    <View className="gap-1.5">
      {documents.map(file => (
        <View key={file.uri} className="flex-row items-center gap-2">
          <FileIcon size={14} color={colors.mutedForeground} />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {file.name}
          </Text>
          <Text className="text-xs text-muted-foreground">{formatFileSize(file.measuredSize)}</Text>
        </View>
      ))}
    </View>
  );
}

function RejectionNotes({ notes }: { notes: readonly RejectedNote[] }) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <View className="gap-0.5">
      {notes.map(note => (
        <Text key={`${note.name}-${note.reason}`} className="text-xs text-muted-foreground">
          {note.name}: {describeClassificationFailure(note.reason)}
        </Text>
      ))}
    </View>
  );
}

/**
 * Height-bounded payload preview for the share gate header.
 * Images → horizontal thumbnail row (max 5, ~64pt). Documents → name + size.
 * Text → clamped to 3 lines. Skeleton while async measurement runs.
 */
export function SharePayloadPreview({ payload, validation }: Readonly<SharePayloadPreviewProps>) {
  if (validation === null) {
    return (
      <View className="gap-2 px-4 pb-2">
        <Skeleton className="h-16 w-full rounded-md" />
      </View>
    );
  }

  if (validation.kind === 'all-rejected') {
    return null;
  }

  const text = payload.text.trim();
  const hasText = text !== '';
  const hasFiles = validation.accepted.length > 0;

  return (
    <View className="gap-2 px-4 pb-2">
      {hasText ? (
        <Text numberOfLines={3} className="text-sm leading-5 text-foreground">
          {text}
        </Text>
      ) : null}
      {hasFiles ? (
        <>
          <PreviewImages files={validation.accepted} />
          <PreviewDocuments files={validation.accepted} />
        </>
      ) : null}
      {validation.truncated ? (
        <Text className="text-xs text-muted-foreground">
          Only the first {AGENT_ATTACHMENT_MAX_FILES} files will be attached.
        </Text>
      ) : null}
      <RejectionNotes notes={validation.rejectedNotes} />
    </View>
  );
}
