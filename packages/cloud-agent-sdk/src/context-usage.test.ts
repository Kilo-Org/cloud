import type { AssistantMessage, UserMessage } from '@kilocode/app-shared/opencode';
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

/**
 * A compaction summary the CLI wrote for `/compact`: `summary: true` on an
 * assistant message (see the CLI's `SessionCompaction.process`). `finish` is
 * set when the compaction completed; the CLI leaves the tokens at zero on the
 * chunked path and reports the compaction request's usage on the direct path.
 */
function compactionSummaryMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return assistantMessage({
    id: 'msg-summary',
    parentID: 'msg-compaction-user',
    mode: 'compaction',
    agent: 'compaction',
    summary: true,
    finish: 'stop',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  });
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

describe('findLatestContextUsage across a compaction', () => {
  /** The 96%-full response the session reported before `/compact`. */
  const preCompaction = assistantMessage({
    id: 'msg-before-compaction',
    tokens: { input: 190_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  /** The first report after `/compact`: the compacted context. */
  const postCompaction = assistantMessage({
    id: 'msg-after-compaction',
    tokens: { input: 27_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
  });

  it('drops the pre-compaction reading once the compaction completes', () => {
    expect(
      findLatestContextUsage([
        { info: preCompaction },
        { info: userMessage({ id: 'msg-compaction-user' }) },
        { info: compactionSummaryMessage() },
      ])
    ).toBeUndefined();
  });

  it('never falls back to the pre-compaction reading while a post-compaction turn streams', () => {
    const streaming = assistantMessage({
      id: 'msg-after-compaction',
      tokens: { input: 27_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    expect(
      findLatestContextUsage([
        { info: preCompaction },
        { info: compactionSummaryMessage() },
        { info: streaming },
      ])
    ).toBeUndefined();
  });

  it('reads the post-compaction turn once it reports, and not the pre-compaction figure', () => {
    expect(
      findLatestContextUsage([
        { info: preCompaction },
        { info: compactionSummaryMessage() },
        { info: postCompaction },
      ])
    ).toEqual({
      contextTokens: 27_500,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('ignores a completed summary report that restates the pre-compaction history', () => {
    const summary = compactionSummaryMessage({
      tokens: { input: 190_000, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    expect(findLatestContextUsage([{ info: preCompaction }, { info: summary }])).toBeUndefined();
  });

  it('keeps the pre-compaction reading while the compaction is still running', () => {
    const running = compactionSummaryMessage({ finish: undefined });

    expect(findLatestContextUsage([{ info: preCompaction }, { info: running }])).toEqual({
      contextTokens: 191_000,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('keeps the pre-compaction reading when the compaction failed', () => {
    const failed = compactionSummaryMessage({
      error: {
        name: 'UnknownError',
        data: { message: 'compaction failed' },
      },
    });

    expect(findLatestContextUsage([{ info: preCompaction }, { info: failed }])).toEqual({
      contextTokens: 191_000,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('treats a finished summary whose error is serialized as null as a boundary', () => {
    // Some serializers write an absent optional as an explicit null; a
    // finished summary with no error is still the compaction boundary.
    const completedWithNullError = { ...compactionSummaryMessage(), error: null };

    expect(
      findLatestContextUsage([{ info: preCompaction }, { info: completedWithNullError }])
    ).toBeUndefined();
  });

  it('reads from after the newest compaction, not an older compacted context', () => {
    expect(
      findLatestContextUsage([
        { info: preCompaction },
        { info: compactionSummaryMessage({ id: 'msg-summary-1' }) },
        { info: postCompaction },
        { info: compactionSummaryMessage({ id: 'msg-summary-2' }) },
      ])
    ).toBeUndefined();
  });

  it('reports the compacted context after the second compaction completes', () => {
    const afterSecond = assistantMessage({
      id: 'msg-after-second-compaction',
      tokens: { input: 5_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    expect(
      findLatestContextUsage([
        { info: preCompaction },
        { info: compactionSummaryMessage({ id: 'msg-summary-1' }) },
        { info: postCompaction },
        { info: compactionSummaryMessage({ id: 'msg-summary-2' }) },
        { info: afterSecond },
      ])
    ).toEqual({
      contextTokens: 5_100,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });
});

describe('findLatestContextUsage across the compaction request part', () => {
  /** The 96%-full response the session reported before `/compact`. */
  const preCompaction = assistantMessage({
    id: 'msg-before-compaction',
    tokens: { input: 190_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  /** The first report after `/compact`: the compacted context. */
  const postCompaction = assistantMessage({
    id: 'msg-after-compaction',
    tokens: { input: 27_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  /** The part the CLI puts on the `/compact` request's user message. */
  const compactionPart = {
    id: 'prt-compaction',
    sessionID: 'ses-root',
    messageID: 'msg-compaction-user',
    type: 'compaction',
  };
  /** The compaction request's user message as the transcript shows it. */
  const compactionRequest = {
    info: userMessage({ id: 'msg-compaction-user' }),
    parts: [compactionPart],
  };

  it('never falls back to the pre-compaction reading once the compaction part arrived', () => {
    // The transcript renders "Context compacted" from this part alone; the
    // summary message's own events may still be missing when it is visible.
    expect(findLatestContextUsage([{ info: preCompaction }, compactionRequest])).toBeUndefined();
  });

  it('reads the post-compaction turn reported after the compaction part', () => {
    expect(
      findLatestContextUsage([{ info: preCompaction }, compactionRequest, { info: postCompaction }])
    ).toEqual({
      contextTokens: 27_500,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('holds the boundary even when the summary message is still streaming', () => {
    expect(
      findLatestContextUsage([
        { info: preCompaction },
        compactionRequest,
        { info: compactionSummaryMessage({ finish: undefined }) },
      ])
    ).toBeUndefined();
  });

  it('keeps the pre-compaction reading when the compaction part is followed by a failed summary', () => {
    // The compaction failed, so the pre-compaction context is still in force;
    // the request's part must not blank the still-valid reading.
    const failed = compactionSummaryMessage({
      error: {
        name: 'UnknownError',
        data: { message: 'compaction failed' },
      },
    });

    expect(
      findLatestContextUsage([{ info: preCompaction }, compactionRequest, { info: failed }])
    ).toEqual({
      contextTokens: 191_000,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
  });

  it('still blanks after a completed compaction that followed a failed one', () => {
    const failed = compactionSummaryMessage({
      id: 'msg-summary-1',
      error: {
        name: 'UnknownError',
        data: { message: 'compaction failed' },
      },
    });

    expect(
      findLatestContextUsage([
        { info: preCompaction },
        compactionRequest,
        { info: failed },
        { info: userMessage({ id: 'msg-second-compaction-user' }) },
        { info: compactionSummaryMessage({ id: 'msg-summary-2' }) },
      ])
    ).toBeUndefined();
  });

  it('ignores parts that are not compaction markers', () => {
    expect(
      findLatestContextUsage([
        { info: preCompaction },
        { info: userMessage(), parts: [{ type: 'text', text: 'hello' }] },
      ])
    ).toEqual({
      contextTokens: 191_000,
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4',
    });
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
