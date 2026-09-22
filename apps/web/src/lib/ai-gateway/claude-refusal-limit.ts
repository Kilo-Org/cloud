import 'server-only';

import { redisClient } from '@/lib/redis';
import { claudeRefusalCountRedisKey } from '@/lib/redis-keys';

export const CLAUDE_REFUSAL_LIMIT = 3;
export const CLAUDE_REFUSAL_TTL_SECONDS = 7 * 24 * 60 * 60;

const RECORD_REFUSAL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export async function isClaudeRefusalLimited(accountId: string): Promise<boolean> {
  try {
    const count = await redisClient.get<string>(claudeRefusalCountRedisKey(accountId));
    return count !== null && Number(count) >= CLAUDE_REFUSAL_LIMIT;
  } catch {
    return false;
  }
}

export async function recordClaudeRefusal(accountId: string): Promise<void> {
  try {
    const key = claudeRefusalCountRedisKey(accountId);
    await redisClient.eval(RECORD_REFUSAL_SCRIPT, [key], [CLAUDE_REFUSAL_TTL_SECONDS]);
  } catch {
    return;
  }
}
