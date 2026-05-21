import { MessageInputWithAttachmentQueue } from './message-input-attachment-queue';
import { MessageInputContent } from './message-input-content';
import {
  type AttachmentEnabledProps,
  type CommonProps,
  type MessageInputProps,
} from './message-input-types';

export function MessageInput(props: MessageInputProps) {
  if (hasAttachmentQueueProps(props)) {
    const { client, conversationId, hasAttachmentsCapability } = props;
    const { onSend, ...contentProps } = props;
    return (
      <MessageInputWithAttachmentQueue
        {...contentProps}
        client={client}
        conversationId={conversationId}
        hasAttachmentsCapability={hasAttachmentsCapability}
        onSendContentBlocks={onSend}
      />
    );
  }

  const { onSend, ...textProps } = props;
  return (
    <MessageInputContent
      {...textProps}
      hasAttachmentsCapability={false}
      attachmentQueue={null}
      onSendText={onSend}
    />
  );
}

function hasAttachmentQueueProps(
  props: MessageInputProps
): props is CommonProps & AttachmentEnabledProps {
  return props.client !== undefined;
}
