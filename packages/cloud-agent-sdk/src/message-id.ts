import { cloudAgentSdkRuntime } from './runtime';
import {
  buildMessageId,
  MESSAGE_ID_RANDOM_LENGTH,
} from '@kilocode/session-ingest-contracts/message-id';

// Kilo format: msg_ + 6 bytes as hex (12 chars, time-based) + 14 base62 chars (random)
export function generateMessageId(): string {
  return buildMessageId(Date.now(), cloudAgentSdkRuntime.randomBytes(MESSAGE_ID_RANDOM_LENGTH));
}
