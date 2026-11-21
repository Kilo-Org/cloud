import { Redis } from '@upstash/redis';

// Redis commands should still be fast over REST; anything over 200ms means Redis
// is overloaded or unreachable and callers should fail open.
const COMMAND_TIMEOUT_MS = 200;

// Writes that nothing waits for, such as `after()` work, can afford a slower
// round trip, like an sfo1 gateway write to the fra1 primary.
const DEFERRED_COMMAND_TIMEOUT_MS = 2_000;

export const redisClient = Redis.fromEnv({
  automaticDeserialization: false,
  retry: false,
  signal: () => AbortSignal.timeout(COMMAND_TIMEOUT_MS),
});

/**
 * For commands that no request waits for. Like `redisClient` it never retries: a timed-out
 * command may still have run, so a retry could apply a non-idempotent write such as INCRBY twice.
 */
export const deferredRedisClient = Redis.fromEnv({
  automaticDeserialization: false,
  retry: false,
  signal: () => AbortSignal.timeout(DEFERRED_COMMAND_TIMEOUT_MS),
});
