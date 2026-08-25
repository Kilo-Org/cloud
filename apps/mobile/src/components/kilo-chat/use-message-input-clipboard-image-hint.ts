import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import {
  clipboardPasteEmptyMessage,
  useClipboardPaste,
} from '@/lib/agent-attachments/use-clipboard-paste';
import { buildAttachmentUnreadableToast } from './message-attachment-state';
import { type ComposerAttachmentQueue } from './message-input-types';

type UseMessageInputClipboardImageHintInputs = {
  showAttachmentButton: boolean;
  controlsDisabled: boolean;
  voiceInputActive: boolean;
  attachmentQueue: ComposerAttachmentQueue | null;
};

export function useMessageInputClipboardImageHint({
  showAttachmentButton,
  controlsDisabled,
  voiceInputActive,
  attachmentQueue,
}: UseMessageInputClipboardImageHintInputs) {
  return useClipboardPaste({
    enabled: showAttachmentButton && !controlsDisabled && !voiceInputActive,
    addFile: async file => {
      await attachmentQueue?.addClipboardImage(file);
    },
    onFailure: reason => {
      toast.error(
        reason === 'empty'
          ? clipboardPasteEmptyMessage()
          : buildAttachmentUnreadableToast(i18n.t('chat.attachment.pastedImage'))
      );
    },
  });
}
