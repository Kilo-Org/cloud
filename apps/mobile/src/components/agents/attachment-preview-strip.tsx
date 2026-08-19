import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import { File } from 'expo-file-system';
import { toast } from 'sonner-native';
import { useActionSheet } from '@expo/react-native-action-sheet';

import { AlertCircle, File as FileIcon, RotateCcw, X } from '@/components/ui/icons';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type AgentAttachment } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { describeAttachmentChip } from '@/components/agents/attachment-chip-description';
import { ImageViewerModal } from '@/components/image-viewer-modal';
import { SheetHeader } from '@/components/sheet-header';
import { SelectableText } from '@/components/ui/selectable-text';
import {
  getShareRemoteFileReason,
  shareLocalFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';
import { isMarkdownPath } from '@/components/agents/read-tool-markdown';
import { MarkdownText } from '@/components/agents/markdown-text';

type Props = {
  attachments: AgentAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
};

/** 28pt visible button + 8pt slop on every side = 44pt effective target. */
const REMOVE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

const UNKNOWN_OPEN_OPTIONS = ['Open as text', 'Open in external app', 'Cancel'] as const;
const UNKNOWN_OPEN_CANCEL_INDEX = UNKNOWN_OPEN_OPTIONS.length - 1;

function renderPreviewBody(preview: { mode: 'markdown' | 'text'; text: string }) {
  if (preview.text === '') {
    return <Text className="text-xs text-muted-foreground">This file is empty.</Text>;
  }
  if (preview.mode === 'markdown') {
    return <MarkdownText value={preview.text} />;
  }
  return (
    <SelectableText className="text-sm leading-5 text-foreground">{preview.text}</SelectableText>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: AgentAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const [viewerVisible, setViewerVisible] = useState(false);
  const [textPreview, setTextPreview] = useState<{
    mode: 'markdown' | 'text';
    text: string;
  } | null>(null);
  const isImage = attachment.kind === 'image';
  const isUploading = attachment.status === 'pending' || attachment.status === 'uploading';
  const isErrored = attachment.status === 'error';
  const description = describeAttachmentChip({
    filename: attachment.filename,
    size: attachment.size,
    status: attachment.status,
    progress: attachment.progress,
    terminal: attachment.terminal,
  });

  async function openLocalText(mode: 'markdown' | 'text') {
    try {
      const text = await new File(attachment.localUri).text();
      setTextPreview({ mode, text });
    } catch {
      toast.error('Failed to open file. Please try again.');
    }
  }

  async function shareUnknown() {
    try {
      await shareLocalFile(attachment.localUri, { mimeType: attachment.mimeType });
    } catch (error: unknown) {
      const reason = getShareRemoteFileReason(error);
      if (reason === 'sharing-unavailable') {
        toast.error('File sharing is not available on this device.');
        return;
      }
      if (error instanceof ShareRemoteFileError) {
        toast.error('Failed to share file. Please try again.');
        return;
      }
      toast.error('Share failed');
    }
  }

  function handleOpen() {
    if (attachment.kind === 'image') {
      setViewerVisible(true);
      return;
    }
    if (isMarkdownPath(attachment.filename)) {
      void openLocalText('markdown');
      return;
    }
    showActionSheetWithOptions(
      {
        options: [...UNKNOWN_OPEN_OPTIONS],
        cancelButtonIndex: UNKNOWN_OPEN_CANCEL_INDEX,
      },
      index => {
        if (index === 0) {
          void openLocalText('text');
        } else if (index === 1) {
          void shareUnknown();
        }
      }
    );
  }

  const accessibilityValue =
    isUploading && attachment.progress !== null
      ? { min: 0, max: 100, now: Math.round(attachment.progress * 100) }
      : undefined;
  const accessibilityState =
    isUploading && attachment.progress === null ? { busy: true } : undefined;

  const bodyContent = (
    // Visual descendants are excluded from the accessibility tree so
    // the body stays the single announced element: the nested Texts,
    // the decorative thumbnail, and the uploading ActivityIndicator
    // must never surface as duplicate nodes.
    <View
      className="h-full w-full"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {isImage ? (
        <Image
          source={{ uri: attachment.localUri }}
          className="h-full w-full"
          contentFit="cover"
          transition={0}
          allowDownscaling
          recyclingKey={attachment.id}
          cachePolicy="memory"
        />
      ) : (
        <View
          className={cn(
            'h-full w-full flex-row items-center gap-2',
            // Row 3.3: the Retry control sits in the bottom-LEFT corner, so
            // the retryable chip's file content shifts right of its 44pt
            // target instead of being hidden underneath it.
            description.showRetry ? 'pl-10 pr-2' : 'px-2'
          )}
        >
          {isErrored ? (
            <AlertCircle size={14} color={colors.destructive} />
          ) : (
            <FileIcon size={14} color={colors.mutedForeground} />
          )}
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs text-foreground">
              {description.filename}
            </Text>
            <Text numberOfLines={1} className="text-[10px] text-muted-foreground">
              {description.message ?? `${description.sizeText} · ${description.progressText}`}
            </Text>
          </View>
        </View>
      )}

      {isImage && isUploading ? (
        <View className="absolute inset-0 items-center justify-center bg-black/30">
          <ActivityIndicator size="small" color={colors.foreground} />
        </View>
      ) : null}

      {isImage && isErrored ? (
        <View className="absolute inset-0 items-center justify-center bg-black/30">
          <AlertCircle size={20} color="white" />
        </View>
      ) : null}
    </View>
  );

  return (
    <>
      {/* Outer wrapper keeps the strip's horizontal spacing (mr-2) and anchors
          the absolute Retry/Remove controls. It has NO overflow-hidden, so a
          parent never clips the controls' hitSlop; the rounded-image clipping
          lives on the surface view below, which is not their ancestor. Each
          control keeps its full 44pt effective target at runtime. */}
      <View className="relative mr-2">
        {/* Chip surface — the single accessible element describing the
            attachment. The container above stays non-accessible so the sibling
            Retry and Remove controls are individually reachable instead of
            being shadowed by an accessible parent. */}
        <View
          className={cn(
            'overflow-hidden rounded-md border border-border bg-card',
            isImage ? 'h-16 w-20' : 'h-12 w-48',
            description.showRetry && 'border-destructive',
            isErrored && !description.showRetry && 'border-destructive/60'
          )}
        >
          {description.showRetry ? (
            // A retryable chip keeps the body as a non-interactive View: the
            // full-chip Retry overlay below is the tap target.
            <View
              className="h-full w-full"
              accessible
              accessibilityLabel={description.accessibilityLabel}
              accessibilityRole={isUploading ? 'progressbar' : undefined}
              accessibilityValue={accessibilityValue}
              accessibilityState={accessibilityState}
            >
              {bodyContent}
            </View>
          ) : (
            // A non-retryable chip body opens the file on tap.
            <Pressable
              className="h-full w-full active:opacity-70"
              accessible
              onPress={handleOpen}
              accessibilityLabel={description.accessibilityLabel}
              accessibilityRole="button"
              accessibilityValue={accessibilityValue}
              accessibilityState={accessibilityState}
            >
              {bodyContent}
            </Pressable>
          )}
        </View>

        {/* Retry covers the whole chip, restoring the tap-anywhere target a
            failed chip has always had, while staying a SIBLING of the surface and
            of Remove — nesting it as their parent would shadow both for assistive
            technology. It renders before Remove, so Remove wins the overlap. The
            badge is the visible affordance; the content is padded clear of it. */}
        {description.showRetry ? (
          <Pressable
            onPress={onRetry}
            className="absolute inset-0 items-start justify-end p-1 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={`Retry uploading ${attachment.filename}`}
          >
            <View className="h-7 w-7 items-center justify-center rounded-full bg-background">
              <RotateCcw size={14} color={colors.foreground} />
            </View>
          </Pressable>
        ) : null}

        {description.showRemove ? (
          <Pressable
            onPress={onRemove}
            hitSlop={REMOVE_HIT_SLOP}
            className="absolute right-1 top-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={`Remove attachment ${attachment.filename}`}
          >
            <X size={14} color={colors.foreground} />
          </Pressable>
        ) : null}
      </View>

      {viewerVisible ? (
        <ImageViewerModal
          visible={viewerVisible}
          uri={attachment.localUri}
          filename={attachment.filename}
          onClose={() => {
            setViewerVisible(false);
          }}
        />
      ) : null}

      {textPreview !== null ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => {
            setTextPreview(null);
          }}
        >
          <View className="flex-1 bg-background">
            <SheetHeader
              title={attachment.filename}
              onDone={() => {
                setTextPreview(null);
              }}
              doneLabel="Done"
            />
            <ScrollView contentContainerClassName="px-6 pb-6 pt-2">
              {renderPreviewBody(textPreview)}
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

export function AttachmentPreviewStrip({ attachments, onRemove, onRetry }: Readonly<Props>) {
  if (attachments.length === 0) {
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
      {attachments.map(attachment => (
        <AttachmentChip
          key={attachment.id}
          attachment={attachment}
          onRemove={() => {
            onRemove(attachment.id);
          }}
          onRetry={() => {
            onRetry(attachment.id);
          }}
        />
      ))}
    </ScrollView>
  );
}
