import { useActionSheet } from '@expo/react-native-action-sheet';
import { useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';
import {
  type AddFileInput,
  useAttachmentQueue,
  type UseAttachmentQueueOptions,
} from '@kilocode/kilo-chat-hooks';
import { type KiloChatOperation } from '@kilocode/kilo-chat';

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
  const onSizeRejected = useCallback(
    (input: AddFileInput) => {
      if (client.canStartOperation()) {
        toast.error(buildAttachmentSizeRejectionToast(input.filename));
      }
    },
    [client]
  );
  const queueOptions = {
    performUpload: mobilePerformUpload,
    maxBytes: MOBILE_ATTACHMENT_MAX_BYTES,
    onSizeRejected,
    captureOperation: () => client.captureOperation(),
  } satisfies UseAttachmentQueueOptions &
    Required<Pick<UseAttachmentQueueOptions, 'captureOperation'>>;
  const queue = useAttachmentQueue(client, conversationId, queueOptions);
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();

  const addSelectedAttachments = useCallback(
    async (selected: readonly MessageAttachment[], operation: KiloChatOperation) => {
      if (selected.length === 0) {
        return;
      }
      operation.assertDispatch();
      // Gate size/capacity before reading bytes. Materialize sequentially to bound memory.
      const { accepted, toast: rejectionToast } = selectAllowedAttachments({
        existingCount: queue.rows.length,
        selected,
      });
      if (rejectionToast) {
        toast.error(rejectionToast);
      }
      for (const attachment of accepted) {
        try {
          operation.assertDispatch();
          // eslint-disable-next-line no-await-in-loop -- sequential materialize bounds peak memory
          const picked = await materializeAttachment(attachment);
          const tempId = queue.addFile({ ...picked.input, operation });
          if (tempId) {
            localUrisRef.current.set(tempId, picked.localUri);
          }
        } catch {
          if (client.canStartOperation()) {
            toast.error(buildAttachmentUnreadableToast(attachment.filename));
          }
        }
      }
    },
    [client, queue]
  );

  const pickFromSource = useCallback(
    async (source: 'camera' | 'library' | 'files', operation: KiloChatOperation) => {
      try {
        operation.assertDispatch();
        const selected = await pickAttachmentsFromSource(source);
        await addSelectedAttachments(selected, operation);
      } catch (error) {
        if (client.canStartOperation()) {
          toast.error(
            error instanceof Error ? error.message : i18n.t('chat.attachment.attachFailed')
          );
        }
      }
    },
    [addSelectedAttachments, client]
  );

  const openPicker = useCallback(() => {
    let operation: KiloChatOperation | undefined = undefined;
    try {
      operation = client.captureOperation();
    } catch {
      return;
    }
    const actionSheet = getAttachmentActionSheetConfig();
    showActionSheetWithOptions(
      {
        ...actionSheet,
        options: [...actionSheet.options],
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          void pickFromSource('camera', operation);
        } else if (index === 1) {
          void pickFromSource('library', operation);
        } else if (index === 2) {
          void pickFromSource('files', operation);
        }
      }
    );
  }, [bottom, client, pickFromSource, showActionSheetWithOptions]);

  const addClipboardImage = useCallback(
    async (file: ClipboardImageFile) => {
      const operation = client.captureOperation();
      await addSelectedAttachments([clipboardImageToSelection(file)], operation);
    },
    [addSelectedAttachments, client]
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
