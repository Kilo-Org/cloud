import { type Message } from './types';

export type MessageActionAvailability = {
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReply: boolean;
  canExecuteAction: boolean;
};

export function buildMessageActionAvailability(
  message: Message,
  isOwn: boolean
): MessageActionAvailability {
  const canUseApiBackedActions = !message.id.startsWith('pending-') && !message.deleted;

  return {
    canReact: canUseApiBackedActions && !message.deliveryFailed,
    canEdit: canUseApiBackedActions && isOwn && !message.deliveryFailed,
    canDelete: canUseApiBackedActions && isOwn,
    canReply: canUseApiBackedActions && !message.deliveryFailed,
    canExecuteAction: canUseApiBackedActions,
  };
}
