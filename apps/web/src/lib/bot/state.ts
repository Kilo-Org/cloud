import { createRedisState } from '@chat-adapter/state-redis';
import { createMemoryState } from '@chat-adapter/state-memory';
import type { StateAdapter } from 'chat';

let chatState: StateAdapter | undefined;

export function createChatState(): StateAdapter {
  chatState ??= process.env.REDIS_URL ? createRedisState() : createMemoryState();
  return chatState;
}
