import type { AssistantMessage, UserMessage } from '@/types/opencode.gen';
import { calculateContextUsagePercentage, findLatestContextUsage } from './context-usage';

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-assistant',
    sessionID: 'ses-root',
    role: 'assistant',
    time: { created: 1 },
    parentID: 'msg-user',
    modelID: 'anthropic/claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
}

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'msg-user',
    sessionID: 'ses-root',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: {
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    },
    ...overrides,
  };
}

describe('findLatestContextUsage', () => {
  it('sums all token buckets from an eligible assistant response', () => {
    const message = assistantMessage({
      tokens: {
        input: 10,
        output: 20,
        reasoning: 30,
        cache: { read: 40, write: 50 },
      },
    });

    expect(findLatestContextUsage([{ info: message }])).toEqual({
      contextTokens: 150,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('uses the latest eligible assistant response without summing responses', () => {
    const first = assistantMessage({
      id: 'msg-assistant-1',
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const second = assistantMessage({
      id: 'msg-assistant-2',
      modelID: 'openai/gpt-5',
      tokens: { input: 20, output: 20, reasoning: 5, cache: { read: 3, write: 2 } },
    });

    expect(findLatestContextUsage([{ info: first }, { info: second }])).toEqual({
      contextTokens: 50,
      providerID: 'kilo',
      modelID: 'openai/gpt-5',
    });
  });

  it('ignores trailing user messages', () => {
    const assistant = assistantMessage();

    expect(findLatestContextUsage([{ info: assistant }, { info: userMessage() }])).toEqual({
      contextTokens: 1,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('keeps the previous eligible response while the newest assistant has zero output', () => {
    const previous = assistantMessage({ id: 'msg-assistant-1' });
    const streaming = assistantMessage({
      id: 'msg-assistant-2',
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    expect(findLatestContextUsage([{ info: previous }, { info: streaming }])).toEqual({
      contextTokens: 1,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('switches to the newest assistant after its first output token', () => {
    const previous = assistantMessage({ id: 'msg-assistant-1' });
    const streaming = assistantMessage({
      id: 'msg-assistant-2',
      modelID: 'openai/gpt-5',
      tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    expect(findLatestContextUsage([{ info: previous }, { info: streaming }])).toEqual({
      contextTokens: 101,
      providerID: 'kilo',
      modelID: 'openai/gpt-5',
    });
  });

  it('returns undefined when no assistant has emitted output', () => {
    expect(findLatestContextUsage([{ info: userMessage() }])).toBeUndefined();
    expect(
      findLatestContextUsage([
        {
          info: assistantMessage({
            tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        },
      ])
    ).toBeUndefined();
  });

  it('fails closed when the latest eligible assistant payload is malformed', () => {
    const valid = assistantMessage();
    const malformed = {
      role: 'assistant',
      providerID: 'kilo',
      modelID: 'openai/gpt-5',
      tokens: { input: 100, output: 1, reasoning: 0 },
    };

    expect(findLatestContextUsage([{ info: valid }, { info: malformed }])).toBeUndefined();
  });

  it('skips assistant payloads whose finite buckets overflow when summed', () => {
    const overflowing = assistantMessage({
      tokens: {
        input: Number.MAX_VALUE,
        output: Number.MAX_VALUE,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });

    expect(findLatestContextUsage([{ info: overflowing }])).toBeUndefined();
  });
});

describe('calculateContextUsagePercentage', () => {
  it('rounds a valid context-window percentage to an integer', () => {
    expect(calculateContextUsagePercentage(32_418, 80_000)).toBe(41);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns undefined for invalid context window %s',
    contextWindow => {
      expect(calculateContextUsagePercentage(32_418, contextWindow)).toBeUndefined();
    }
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns undefined for invalid context token count %s',
    contextTokens => {
      expect(calculateContextUsagePercentage(contextTokens, 80_000)).toBeUndefined();
    }
  );

  it('returns undefined when percentage arithmetic overflows', () => {
    expect(calculateContextUsagePercentage(Number.MAX_VALUE, Number.MIN_VALUE)).toBeUndefined();
  });

  it('preserves percentages above one hundred', () => {
    expect(calculateContextUsagePercentage(101, 100)).toBe(101);
  });
});
