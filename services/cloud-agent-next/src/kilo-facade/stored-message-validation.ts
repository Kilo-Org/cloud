import {
  kiloSdkStoredMessageSchema,
  type KiloSdkPart,
  type KiloSdkStoredMessage,
} from '@kilocode/session-ingest-contracts';

function isOwnedPart(part: KiloSdkPart, kiloSessionId: string, messageId: string): boolean {
  if (part.sessionID !== kiloSessionId || part.messageID !== messageId) return false;
  if (part.type !== 'tool' || part.state.status !== 'completed' || !part.state.attachments)
    return true;
  return part.state.attachments.every(
    attachment => attachment.sessionID === kiloSessionId && attachment.messageID === messageId
  );
}

function isOwnedStoredMessage(
  message: KiloSdkStoredMessage,
  kiloSessionId: string,
  expectedMessageId?: string
): boolean {
  if (message.info.sessionID !== kiloSessionId) return false;
  if (expectedMessageId !== undefined && message.info.id !== expectedMessageId) return false;
  return message.parts.every(part => isOwnedPart(part, kiloSessionId, message.info.id));
}

export function parseOwnedKiloSdkStoredMessage(
  value: unknown,
  kiloSessionId: string,
  expectedMessageId?: string
): KiloSdkStoredMessage | null {
  try {
    const parsed = kiloSdkStoredMessageSchema.safeParse(value);
    if (!parsed.success || !isOwnedStoredMessage(parsed.data, kiloSessionId, expectedMessageId)) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function parseOwnedKiloSdkStoredMessages(
  value: unknown,
  kiloSessionId: string
): KiloSdkStoredMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: KiloSdkStoredMessage[] = [];
  for (const entry of value) {
    const message = parseOwnedKiloSdkStoredMessage(entry, kiloSessionId);
    if (!message) return null;
    messages.push(message);
  }
  return messages;
}
