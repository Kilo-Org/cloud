import { useActionSheet } from '@expo/react-native-action-sheet';
import { useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';
import { ATTACHMENT_MAX_BYTES } from '@kilocode/kilo-chat';
import { type AddFileInput, useAttachmentQueue } from '@kilocode/kilo-chat-hooks';

import {
  addFilesWithinAttachmentCapacity,
  buildAttachmentLimitToast,
  buildAttachmentSizeRejectionToast,
  getAttachmentActionSheetConfig,
  MESSAGE_ATTACHMENT_MAX_COUNT,
} from './message-attachment-state';
import {
  pickCameraImage,
  type PickedAttachment,
  pickFiles,
  pickLibraryImages,
} from './message-attachment-picker';
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
    maxBytes: ATTACHMENT_MAX_BYTES,
    onSizeRejected,
  });
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();

  const addFiles = useCallback(
    (picked: PickedAttachment[]) => {
      const capacity = Math.max(MESSAGE_ATTACHMENT_MAX_COUNT - queue.rows.length, 0);
      addFilesWithinAttachmentCapacity({
        inputs: picked,
        capacity,
        addFile: (item: PickedAttachment) => queue.addFile(item.input),
        onAcceptedFile: (item, tempId) => {
          if (tempId) {
            localUrisRef.current.set(tempId, item.localUri);
          }
        },
        onLimitExceeded: () => {
          toast.error(buildAttachmentLimitToast());
        },
      });
    },
    [queue]
  );

  const pickFromSource = useCallback(
    async (source: 'camera' | 'library' | 'files') => {
      try {
        const inputs = await pickAttachmentsFromSource(source);
        addFiles(inputs);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to attach file');
      }
    },
    [addFiles]
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
): Promise<PickedAttachment[]> {
  if (source === 'camera') {
    return pickCameraImage();
  }
  if (source === 'library') {
    return pickLibraryImages();
  }
  return pickFiles();
}
