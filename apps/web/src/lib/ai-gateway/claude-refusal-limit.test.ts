import { redisClient } from '@/lib/redis';
import {
  CLAUDE_REFUSAL_LIMIT,
  CLAUDE_REFUSAL_TTL_SECONDS,
  isClaudeRefusalLimited,
  recordClaudeRefusal,
} from './claude-refusal-limit';

jest.mock('@/lib/redis', () => ({
  redisClient: {
    get: jest.fn(),
    eval: jest.fn(),
  },
}));

const mockedGet = jest.mocked(redisClient.get);
const mockedEval = jest.mocked(redisClient.eval);

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedEval.mockResolvedValue(1);
});

describe('Claude refusal limit', () => {
  it('blocks an account at the refusal threshold', async () => {
    mockedGet.mockResolvedValue(String(CLAUDE_REFUSAL_LIMIT));

    await expect(isClaudeRefusalLimited('org-123')).resolves.toBe(true);
    expect(mockedGet).toHaveBeenCalledWith('ai-gateway:claude-refusals:v1:org-123');
  });

  it('allows an account below the refusal threshold', async () => {
    mockedGet.mockResolvedValue(String(CLAUDE_REFUSAL_LIMIT - 1));

    await expect(isClaudeRefusalLimited('user-123')).resolves.toBe(false);
  });

  it('atomically increments the counter and sets a seven-day expiry on creation', async () => {
    await recordClaudeRefusal('user-123');

    expect(mockedEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXPIRE', KEYS[1], ARGV[1])"),
      ['ai-gateway:claude-refusals:v1:user-123'],
      [CLAUDE_REFUSAL_TTL_SECONDS]
    );
  });

  it('fails open when Redis is unavailable', async () => {
    mockedGet.mockRejectedValue(new Error('unavailable'));
    mockedEval.mockRejectedValue(new Error('unavailable'));

    await expect(isClaudeRefusalLimited('user-123')).resolves.toBe(false);
    await expect(recordClaudeRefusal('user-123')).resolves.toBeUndefined();
  });
});
