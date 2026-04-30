import { type Message } from '@kilocode/kilo-chat';

export function canEditOrDeleteMessage(message: Message, currentUserId: string | null): boolean {
  return (
    currentUserId !== null &&
    message.senderId === currentUserId &&
    !message.deleted &&
    !message.deliveryFailed &&
    !message.id.startsWith('pending-')
  );
}

export function editableTextForMessage(message: Message): string | null {
  const textParts: string[] = [];
  for (const block of message.content) {
    if (block.type !== 'text') {
      return null;
    }
    textParts.push(block.text);
  }
  return textParts.join('\n');
}

export function deliveryFailureTextForMessage(message: Message): string | null {
  return message.deliveryFailed ? 'Not delivered to bot' : null;
}
