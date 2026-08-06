import { toast } from 'sonner-native';

import { useClipboardPaste } from '@/lib/agent-attachments/use-clipboard-paste';
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
    onUnreadable: () => {
      toast.error(buildAttachmentUnreadableToast('the pasted image'));
    },
  });
}
