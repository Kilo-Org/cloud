/* eslint-disable max-lines -- cohesive chip: thumbnail, status overlays, retry/remove controls, viewer, text preview, and reorder drag/actions share one strip component */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  ScrollView as GestureScrollView,
} from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File } from 'expo-file-system';
import { toast } from 'sonner-native';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import { AlertCircle, File as FileIcon, RotateCcw, X } from '@/components/ui/icons';
import { moveA11yFocus } from '@/lib/a11y/announce';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  type AgentAttachment,
  type AttachmentMoveDirection,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
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
import { SessionPageSheet } from '@/components/agents/session-page-sheet';

type Props = {
  attachments: AgentAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** Move a chip one position. The composer wires this to `useAgentAttachmentUpload.moveAttachment`. */
  onMove?: (id: string, direction: AttachmentMoveDirection) => void;
  /** Reorder a chip by index (drag). The composer wires this to `useAgentAttachmentUpload.reorderAttachments`. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
};

/** 28pt visible button + 8pt slop on every side = 44pt effective target. */
const REMOVE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

/** Drag arms only after a long press, so ordinary horizontal scroll still wins. */
const LONG_PRESS_MS = 300;

/** Inter-chip spacing, kept in sync with each chip's `mr-2` class. */
const CHIP_GAP = 8;

/**
 * Map a drag's horizontal translation to a target slot. Walks from the start
 * slot and crosses to the next/previous slot once the finger passes the
 * midpoint between the two chips (half of each width plus the inter-chip gap).
 * Clamped to the list bounds. Pure so both the unit test and the mounted drag
 * test share one deterministic contract.
 */
export function dragTargetIndex(
  startIndex: number,
  widths: number[],
  translationX: number
): number {
  const count = widths.length;
  let target = startIndex;
  if (translationX > 0) {
    let traveled = 0;
    for (let i = startIndex; i < count - 1; i += 1) {
      traveled += (widths[i] ?? 0) / 2 + CHIP_GAP + (widths[i + 1] ?? 0) / 2;
      if (translationX >= traveled) {
        target = i + 1;
      } else {
        break;
      }
    }
  } else if (translationX < 0) {
    let traveled = 0;
    for (let i = startIndex; i > 0; i -= 1) {
      traveled -= (widths[i] ?? 0) / 2 + CHIP_GAP + (widths[i - 1] ?? 0) / 2;
      if (translationX <= traveled) {
        target = i - 1;
      } else {
        break;
      }
    }
  }
  return target;
}

function renderPreviewBody(preview: { mode: 'markdown' | 'text'; text: string }) {
  if (preview.text === '') {
    return (
      <Text className="text-xs text-muted-foreground">
        {i18n.t('agentChat.filePart.fileEmpty')}
      </Text>
    );
  }
  if (preview.mode === 'markdown') {
    return <MarkdownText value={preview.text} />;
  }
  return (
    <SelectableText className="text-sm leading-5 text-foreground">{preview.text}</SelectableText>
  );
}

type AttachmentChipProps = {
  attachment: AgentAttachment;
  index: number;
  count: number;
  onRemove: () => void;
  onRetry: () => void;
  onMove: (direction: AttachmentMoveDirection) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  getOrderedWidths: () => number[];
  onLayoutWidth: (width: number) => void;
};

function AttachmentChip({
  attachment,
  index,
  count,
  onRemove,
  onRetry,
  onMove,
  onReorder,
  getOrderedWidths,
  onLayoutWidth,
}: Readonly<AttachmentChipProps>) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const { t } = useTranslation();
  const [viewerVisible, setViewerVisible] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
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

  // The chip body is the single accessible element; focus restoration targets
  // it after a move so VoiceOver/TalkBack stays on the chip that changed slot.
  const bodyRef = useRef<View>(null);
  const focusPendingRef = useRef(false);
  const [focusEpoch, setFocusEpoch] = useState(0);

  const requestFocusRestore = useCallback(() => {
    focusPendingRef.current = true;
    setFocusEpoch(epoch => epoch + 1);
  }, []);

  useEffect(() => {
    if (focusPendingRef.current) {
      focusPendingRef.current = false;
      moveA11yFocus(bodyRef);
    }
  }, [focusEpoch]);

  // One drag-slot reorder per long-press gesture. The start index is captured
  // at gesture start; `runOnJS(true)` lets the callbacks call the reorder and
  // focus helpers without a worklet.
  const dragStartIndexRef = useRef(index);

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Pan().
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .activateAfterLongPress(LONG_PRESS_MS)
    .onStart(() => {
      dragStartIndexRef.current = index;
    })
    .onEnd(event => {
      const startIndex = dragStartIndexRef.current;
      const targetIndex = dragTargetIndex(startIndex, getOrderedWidths(), event.translationX);
      if (targetIndex !== startIndex) {
        onReorder(startIndex, targetIndex);
        requestFocusRestore();
      }
    });

  const moveActions: AccessibilityActionInfo[] = [];
  if (index > 0) {
    moveActions.push({
      name: 'moveLeft',
      label: t('agentChat.attachmentPreview.moveLeft', { filename: attachment.filename }),
    });
  }
  if (index < count - 1) {
    moveActions.push({
      name: 'moveRight',
      label: t('agentChat.attachmentPreview.moveRight', { filename: attachment.filename }),
    });
  }

  function handleAccessibilityAction(event: AccessibilityActionEvent) {
    const action = event.nativeEvent.actionName;
    if (action === 'moveLeft') {
      onMove('left');
      requestFocusRestore();
    } else if (action === 'moveRight') {
      onMove('right');
      requestFocusRestore();
    }
  }

  async function openLocalText(mode: 'markdown' | 'text') {
    try {
      const text = await new File(attachment.localUri).text();
      setTextPreview({ mode, text });
    } catch {
      toast.error(t('agentChat.attachmentPreview.openFailedRetry'));
    }
  }

  async function shareUnknown() {
    try {
      await shareLocalFile(attachment.localUri, { mimeType: attachment.mimeType });
    } catch (error: unknown) {
      const reason = getShareRemoteFileReason(error);
      if (reason === 'sharing-unavailable') {
        toast.error(t('agentChat.filePart.sharingUnavailable'));
        return;
      }
      if (error instanceof ShareRemoteFileError) {
        toast.error(t('agentChat.filePart.shareFailedRetry'));
        return;
      }
      toast.error(t('agentChat.filePart.shareFailed'));
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
        options: [
          t('agentChat.filePart.openAsText'),
          t('agentChat.filePart.openInExternalApp'),
          t('common.cancel'),
        ],
        cancelButtonIndex: 2,
      },
      optionIndex => {
        if (optionIndex === 0) {
          void openLocalText('text');
        } else if (optionIndex === 1) {
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

  const imageThumbnail = imageFailed ? (
    <View className="h-full w-full items-center justify-center">
      <AlertCircle size={20} color={colors.mutedForeground} />
    </View>
  ) : (
    <Image
      source={{ uri: attachment.localUri }}
      className="h-full w-full"
      contentFit="cover"
      transition={0}
      allowDownscaling
      recyclingKey={attachment.id}
      cachePolicy="memory"
      onError={() => {
        setImageFailed(true);
      }}
    />
  );

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
        imageThumbnail
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
        <View className="absolute inset-0 items-center justify-center bg-[#0000004D]">
          <ActivityIndicator size="small" color={colors.foreground} />
        </View>
      ) : null}

      {isImage && isErrored ? (
        <View className="absolute inset-0 items-center justify-center bg-[#0000004D]">
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
      <GestureDetector gesture={panGesture}>
        <View
          className="relative mr-2"
          collapsable={false}
          onLayout={(event: LayoutChangeEvent) => {
            onLayoutWidth(event.nativeEvent.layout.width);
          }}
        >
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
                ref={bodyRef}
                className="h-full w-full"
                accessible
                accessibilityLabel={description.accessibilityLabel}
                accessibilityRole={isUploading ? 'progressbar' : undefined}
                accessibilityValue={accessibilityValue}
                accessibilityState={accessibilityState}
                accessibilityActions={moveActions.length > 0 ? moveActions : undefined}
                onAccessibilityAction={handleAccessibilityAction}
              >
                {bodyContent}
              </View>
            ) : (
              // A non-retryable chip body opens the file on tap.
              <Pressable
                ref={bodyRef}
                className="h-full w-full active:opacity-70"
                accessible
                onPress={handleOpen}
                accessibilityLabel={description.accessibilityLabel}
                accessibilityRole="button"
                accessibilityValue={accessibilityValue}
                accessibilityState={accessibilityState}
                accessibilityActions={moveActions.length > 0 ? moveActions : undefined}
                onAccessibilityAction={handleAccessibilityAction}
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
              accessibilityLabel={t('agentChat.attachmentPreview.retryUploading', {
                filename: attachment.filename,
              })}
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
              accessibilityLabel={t('agentChat.attachmentPreview.removeAttachment', {
                filename: attachment.filename,
              })}
            >
              <X size={14} color={colors.foreground} />
            </Pressable>
          ) : null}
        </View>
      </GestureDetector>

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
        <SessionPageSheet
          visible
          onClose={() => {
            setTextPreview(null);
          }}
        >
          <SheetHeader
            title={attachment.filename}
            onDone={() => {
              setTextPreview(null);
            }}
            doneLabel={t('common.done')}
          />
          <ScrollView className="flex-1" contentContainerClassName="px-6 pb-6 pt-2">
            {renderPreviewBody(textPreview)}
          </ScrollView>
          <View style={{ height: insets.bottom }} className="bg-background" />
        </SessionPageSheet>
      ) : null}
    </>
  );
}

export function AttachmentPreviewStrip({
  attachments,
  onRemove,
  onRetry,
  onMove = () => undefined,
  onReorder = () => undefined,
}: Readonly<Props>) {
  // Per-chip measured widths keyed by id, so a drag can map its translation to
  // a target slot even when image (w-20) and document (w-48) chips interleave.
  const chipWidthsRef = useRef<Record<string, number>>({});
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const recordChipWidth = useCallback((id: string, width: number) => {
    chipWidthsRef.current[id] = width;
  }, []);

  const getOrderedWidths = useCallback(
    () => attachmentsRef.current.map(item => chipWidthsRef.current[item.id] ?? 0),
    []
  );

  if (attachments.length === 0) {
    return null;
  }
  return (
    <GestureScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-2"
      contentContainerClassName="items-center"
      keyboardShouldPersistTaps="handled"
    >
      {attachments.map((attachment, index) => (
        <AttachmentChip
          key={attachment.id}
          attachment={attachment}
          index={index}
          count={attachments.length}
          onRemove={() => {
            onRemove(attachment.id);
          }}
          onRetry={() => {
            onRetry(attachment.id);
          }}
          onMove={direction => {
            onMove(attachment.id, direction);
          }}
          onReorder={onReorder}
          getOrderedWidths={getOrderedWidths}
          onLayoutWidth={width => {
            recordChipWidth(attachment.id, width);
          }}
        />
      ))}
    </GestureScrollView>
  );
}
