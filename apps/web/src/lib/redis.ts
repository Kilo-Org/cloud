import { Redis } from '@upstash/redis';

// Redis commands should still be fast over REST; anything over 200ms means Redis
// is overloaded or unreachable and callers should fail open.
const COMMAND_TIMEOUT_MS = 200;

export const redisClient = Redis.fromEnv({
  automaticDeserialization: false,
  retry: false,
  signal: () => AbortSignal.timeout(COMMAND_TIMEOUT_MS),
});
