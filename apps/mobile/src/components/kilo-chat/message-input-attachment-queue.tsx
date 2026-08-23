import { useActionSheet } from '@expo/react-native-action-sheet';
import { useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';
import { type AddFileInput, useAttachmentQueue } from '@kilocode/kilo-chat-hooks';

import { i18n } from '@/i18n';
import {
  buildAttachmentSizeRejectionToast,
  buildAttachmentUnreadableToast,
  getAttachmentActionSheetConfig,
  type MessageAttachment,
  MOBILE_ATTACHMENT_MAX_BYTES,
  selectAllowedAttachments,
} from './message-attachment-state';
import {
  clipboardImageToSelection,
  materializeAttachment,
  pickCameraImage,
  pickFiles,
  pickLibraryImages,
} from './message-attachment-picker';
import { type ClipboardImageFile } from '@/lib/agent-attachments/clipboard-image';
import { MessageInputContent } from './message-input-content';
import {
  type AttachmentEnabledProps,
  type CommonProps,
  type ComposerAttachmentQueue,
  type MessageInputContentBlocksOnSend,
} from './message-input-types';
import { mobilePerformUpload } from './mobile-perform-upload';

export function MessageInputWithAttachmentQueue({
  client,
  conversationId,
  onSendContentBlocks,
  ...props
}: CommonProps &
  Omit<AttachmentEnabledProps, 'onSend'> & {
    onSendContentBlocks: MessageInputContentBlocksOnSend;
  }) {
  const localUrisRef = useRef<Map<string, string>>(new Map());

  const onSizeRejected = useCallback((input: AddFileInput) => {
    toast.error(buildAttachmentSizeRejectionToast(input.filename));
  }, []);

  const queue = useAttachmentQueue(client, conversationId, {
    performUpload: mobilePerformUpload,
    maxBytes: MOBILE_ATTACHMENT_MAX_BYTES,
    onSizeRejected,
  });
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();

  const addSelectedAttachments = useCallback(
    async (selected: readonly MessageAttachment[]) => {
      if (selected.length === 0) {
        return;
      }

      // Gate on size and capacity before any bytes are read: materializing an
      // oversized file is what runs the device out of memory.
      const { accepted, toast: rejectionToast } = selectAllowedAttachments({
        existingCount: queue.rows.length,
        selected,
      });
      if (rejectionToast) {
        toast.error(rejectionToast);
      }

      // Sequential on purpose: concurrent materialize multiplies peak memory by
      // the selection size. eslint no-await-in-loop wants Promise.all; refuse.
      for (const attachment of accepted) {
        // Per-file, so one unreadable file in a multi-select does not discard the
        // rest. Same message as the gate's unreadable rejection: from the user's
        // side "we could not read this file" is the same fact whether the size
        // stat or the read itself failed.
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential materialize bounds peak memory
          const picked = await materializeAttachment(attachment);
          const tempId = queue.addFile(picked.input);
          if (tempId) {
            localUrisRef.current.set(tempId, picked.localUri);
          }
        } catch {
          toast.error(buildAttachmentUnreadableToast(attachment.filename));
        }
      }
    },
    [queue]
  );

  const pickFromSource = useCallback(
    async (source: 'camera' | 'library' | 'files') => {
      try {
        const selected = await pickAttachmentsFromSource(source);
        await addSelectedAttachments(selected);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : i18n.t('chat.attachment.attachFailed')
        );
      }
    },
    [addSelectedAttachments]
  );

  const openPicker = useCallback(() => {
    const actionSheet = getAttachmentActionSheetConfig();
    showActionSheetWithOptions(
      {
        ...actionSheet,
        options: [...actionSheet.options],
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          void pickFromSource('camera');
        } else if (index === 1) {
          void pickFromSource('library');
        } else if (index === 2) {
          void pickFromSource('files');
        }
      }
    );
  }, [bottom, pickFromSource, showActionSheetWithOptions]);

  const addClipboardImage = useCallback(
    async (file: ClipboardImageFile) => {
      const attachment = clipboardImageToSelection(file);
      await addSelectedAttachments([attachment]);
    },
    [addSelectedAttachments]
  );

  const attachmentQueue: ComposerAttachmentQueue = {
    ...queue,
    getLocalUri: tempId => localUrisRef.current.get(tempId) ?? null,
    openPicker,
    removeFile: tempId => {
      queue.removeFile(tempId);
      localUrisRef.current.delete(tempId);
    },
    clearSubmittedFiles: tempIds => {
      queue.clearFiles(tempIds);
      for (const tempId of tempIds) {
        localUrisRef.current.delete(tempId);
      }
    },
    addClipboardImage,
  };

  return (
    <MessageInputContent
      {...props}
      attachmentQueue={attachmentQueue}
      onSendContentBlocks={onSendContentBlocks}
    />
  );
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- thin pass-through; making it async only to satisfy this rule conflicts with `require-await`.
function pickAttachmentsFromSource(
  source: 'camera' | 'library' | 'files'
): Promise<MessageAttachment[]> {
  if (source === 'camera') {
    return pickCameraImage();
  }
  if (source === 'library') {
    return pickLibraryImages();
  }
  return pickFiles();
}
