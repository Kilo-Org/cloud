import { createRedisState } from '@chat-adapter/state-redis';
import { createMemoryState } from '@chat-adapter/state-memory';
import type { StateAdapter } from 'chat';

export function createChatState(): StateAdapter {
  return process.env.REDIS_URL ? createRedisState() : createMemoryState();
}
