import { toast } from 'sonner-native';

import { useClipboardImageHint } from '@/lib/agent-attachments/use-clipboard-image-hint';
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
  return useClipboardImageHint({
    enabled: showAttachmentButton && !controlsDisabled && !voiceInputActive,
    addFile: async file => {
      await attachmentQueue?.addClipboardImage(file);
    },
    onUnreadable: () => {
      toast.error(buildAttachmentUnreadableToast('the pasted image'));
    },
  });
}
