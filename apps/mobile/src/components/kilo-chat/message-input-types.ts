import {
  type AttachmentBlock,
  type InputContentBlock,
  type KiloChatClient,
  type Message,
} from '@kilocode/kilo-chat';
import { type useAttachmentQueue } from '@kilocode/kilo-chat-hooks';

import { type MessageInputSubmitControls } from './message-input-state';

export type MessageInputTextOnSend = (
  text: string,
  inReplyToMessageId?: string,
  controls?: MessageInputSubmitControls
) => void;

export type MessageInputContentBlocksOnSend = (
  content: InputContentBlock[],
  inReplyToMessageId?: string,
  controls?: MessageInputSubmitControls
) => void;

export type AttachmentEnabledProps = {
  client: KiloChatClient;
  conversationId: string;
  hasAttachmentsCapability: boolean;
  onSend: MessageInputContentBlocksOnSend;
};

export type AttachmentUnavailableProps = {
  client?: never;
  conversationId?: never;
  hasAttachmentsCapability?: false;
  onSend: MessageInputTextOnSend;
};

export type CommonProps = {
  onTyping?: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  initialText?: string;
  isEditing?: boolean;
  onCancelEdit?: () => void;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  disabledReason?: string | null;
  clearOnSubmit?: boolean;
  botName?: string | null;
  typingMembers?: Map<string, number>;
  editableAttachments?: readonly AttachmentBlock[];
  onRemoveEditableAttachment?: (attachmentId: string) => void;
};

export type MessageInputProps = CommonProps & (AttachmentEnabledProps | AttachmentUnavailableProps);

export type ComposerAttachmentQueue = ReturnType<typeof useAttachmentQueue> & {
  getLocalUri: (tempId: string) => string | null;
  openPicker: () => void;
  removeFile: (tempId: string) => void;
  clearSubmittedFiles: (tempIds: string[]) => void;
};
