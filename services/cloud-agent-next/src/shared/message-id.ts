import {
  buildMessageId,
  isCanonicalMessageId,
  MESSAGE_ID_PATTERN,
  MESSAGE_ID_LENGTH,
  MESSAGE_ID_FORMAT_DESCRIPTION,
  MESSAGE_ID_RANDOM_LENGTH,
} from '@kilocode/session-ingest-contracts/message-id';

export {
  isCanonicalMessageId,
  MESSAGE_ID_PATTERN,
  MESSAGE_ID_LENGTH,
  MESSAGE_ID_FORMAT_DESCRIPTION,
};

export function createMessageId(now = Date.now()): string {
  return buildMessageId(now, crypto.getRandomValues(new Uint8Array(MESSAGE_ID_RANDOM_LENGTH)));
}
