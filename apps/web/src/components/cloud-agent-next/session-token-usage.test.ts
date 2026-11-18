import { describe, expect, it } from '@jest/globals';
import type {
  AssistantMessage,
  Part,
  StepFinishPart,
  StoredMessage,
  UserMessage,
} from '@kilocode/cloud-agent-sdk';
import { getSessionTokenUsage, getSessionUsage } from './session-token-usage';

type TokenCounts = {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
};

type AssistantOptions = {
  id?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  error?: AssistantMessage['error'];
};

const zeroUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function createTokens(overrides: Partial<TokenCounts> = {}): TokenCounts {
  return {
    input: overrides.input ?? 0,
    output: overrides.output ?? 0,
    reasoning: overrides.reasoning ?? 0,
    cache: {
      read: overrides.cache?.read ?? 0,
      write: overrides.cache?.write ?? 0,
    },
  };
}

function createAssistantMessage(
  tokens: TokenCounts,
  parts: Part[] = [],
  options: AssistantOptions = {}
): StoredMessage {
  const info: AssistantMessage = {
    id: options.id ?? 'assistant-1',
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1 },
    parentID: 'user-1',
    modelID: options.modelID ?? 'test-model',
    providerID: options.providerID ?? 'test-provider',
    mode: 'code',
    agent: 'test-agent',
    path: { cwd: '/', root: '/' },
    cost: options.cost ?? 0,
    tokens,
    ...(options.error ? { error: options.error } : {}),
  };

  return { info, parts };
}

function createStepFinishPart(tokens: TokenCounts, id = 'step-1', cost = 0): StepFinishPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'step-finish',
    reason: 'stop',
    cost,
    tokens,
  };
}

function createTaskToolPart(): Part {
  return {
    id: 'task-1',
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'task',
    state: {
      status: 'completed',
      input: {},
      output: 'done',
      title: 'Subtask',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function createTextPart(): Part {
  return {
    id: 'text-1',
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'text',
    text: 'hello',
  };
}

function createUserMessage(parts: Part[] = []): StoredMessage {
  const info: UserMessage = {
    id: 'user-1',
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'test-agent',
    model: { providerID: 'test-provider', modelID: 'test-model' },
  };

  return { info, parts };
}

describe('getSessionTokenUsage', () => {
  it('sums each step-finish part instead of double-counting the assistant snapshot', () => {
    const message = createAssistantMessage(
      createTokens({ input: 20, output: 2, reasoning: 1, cache: { read: 3, write: 1 } }),
      [
        createStepFinishPart(
          createTokens({ input: 10, output: 1, reasoning: 0, cache: { read: 2, write: 1 } }),
          'step-1'
        ),
        createStepFinishPart(
          createTokens({ input: 20, output: 2, reasoning: 1, cache: { read: 3, write: 1 } }),
          'step-2'
        ),
      ]
    );

    expect(getSessionTokenUsage([message])).toEqual({
      input: 30,
      output: 3,
      reasoning: 1,
      cacheRead: 5,
      cacheWrite: 2,
    });
  });

  it('falls back to the assistant snapshot when there are no step-finish parts', () => {
    const message = createAssistantMessage(
      createTokens({ input: 50, output: 5, reasoning: 2, cache: { read: 4, write: 3 } }),
      [createTextPart()]
    );

    expect(getSessionTokenUsage([message])).toEqual({
      input: 50,
      output: 5,
      reasoning: 2,
      cacheRead: 4,
      cacheWrite: 3,
    });
  });

  it('counts consumed input from an errored assistant response with zero output', () => {
    const message = createAssistantMessage(createTokens({ input: 400, output: 0 }), [], {
      error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
    });

    expect(getSessionTokenUsage([message])).toEqual({
      ...zeroUsage,
      input: 400,
    });
  });

  it('retains input and output counts when cache counts are zero', () => {
    const message = createAssistantMessage(createTokens(), [
      createStepFinishPart(createTokens({ input: 1_000, output: 250 })),
    ]);

    expect(getSessionTokenUsage([message])).toEqual({
      ...zeroUsage,
      input: 1_000,
      output: 250,
    });
  });

  it('sums usage across assistant messages from different models', () => {
    const messages = [
      createAssistantMessage(createTokens({ input: 10, output: 1 }), [], {
        id: 'assistant-a',
        modelID: 'model-a',
        providerID: 'provider-a',
      }),
      createAssistantMessage(
        createTokens({ input: 20, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }),
        [],
        { id: 'assistant-b', modelID: 'model-b', providerID: 'provider-b' }
      ),
    ];

    expect(getSessionTokenUsage(messages)).toEqual({
      input: 30,
      output: 3,
      reasoning: 1,
      cacheRead: 3,
      cacheWrite: 4,
    });
  });

  it('returns zeros for zero token fields', () => {
    expect(getSessionTokenUsage([createAssistantMessage(createTokens())])).toEqual(zeroUsage);
  });

  it('sanitizes non-finite and negative token counts', () => {
    const message = createAssistantMessage(
      createTokens({
        input: Number.NaN,
        output: Number.POSITIVE_INFINITY,
        reasoning: Number.NEGATIVE_INFINITY,
        cache: { read: -1, write: -2 },
      })
    );

    expect(getSessionTokenUsage([message])).toEqual(zeroUsage);
  });

  it('does not fall back to the assistant snapshot when step-finish tokens are malformed', () => {
    const message = createAssistantMessage(createTokens({ input: 100, output: 50 }), [
      createStepFinishPart(
        createTokens({
          input: Number.NaN,
          output: -1,
          reasoning: Number.POSITIVE_INFINITY,
          cache: { read: -2, write: Number.NaN },
        })
      ),
    ]);

    expect(getSessionTokenUsage([message])).toEqual(zeroUsage);
  });

  it('skips user messages even when their parts contain token counts', () => {
    const messages = [
      createUserMessage([
        createStepFinishPart(createTokens({ input: 9_000, output: 900 }), 'user-step'),
      ]),
      createAssistantMessage(createTokens({ input: 10, output: 1 })),
    ];

    expect(getSessionTokenUsage(messages)).toEqual({
      ...zeroUsage,
      input: 10,
      output: 1,
    });
  });
});

describe('getSessionUsage', () => {
  it('merges non-contiguous messages for the same model in first-seen order', () => {
    const messages = [
      createAssistantMessage(
        createTokens({ input: 10 }),
        [createStepFinishPart(createTokens({ input: 10 }), 'step-a1', 0.01)],
        { id: 'assistant-a1', providerID: 'provider-a', modelID: 'model-a' }
      ),
      createAssistantMessage(
        createTokens({ input: 20 }),
        [createStepFinishPart(createTokens({ input: 20 }), 'step-b1', 0.02)],
        { id: 'assistant-b1', providerID: 'provider-b', modelID: 'model-b' }
      ),
      createAssistantMessage(
        createTokens({ input: 30 }),
        [createStepFinishPart(createTokens({ input: 30 }), 'step-a2', 0.03)],
        { id: 'assistant-a2', providerID: 'provider-a', modelID: 'model-a' }
      ),
    ];

    const usage = getSessionUsage(messages);

    expect(usage.tokens).toEqual({ ...zeroUsage, input: 60 });
    expect(usage.models.map(model => [model.providerID, model.modelID])).toEqual([
      ['provider-a', 'model-a'],
      ['provider-b', 'model-b'],
    ]);
    expect(usage.models[0].tokens).toEqual({ ...zeroUsage, input: 40 });
    expect(usage.models[0].costUsd).toBeCloseTo(0.04, 12);
    expect(usage.models[1].tokens).toEqual({ ...zeroUsage, input: 20 });
    expect(usage.models[1].costUsd).toBeCloseTo(0.02, 12);
  });

  it('keeps the same model ID separate for different providers', () => {
    const messages = [
      createAssistantMessage(
        createTokens({ input: 10 }),
        [createStepFinishPart(createTokens({ input: 10 }), 'step-1', 0.01)],
        { id: 'assistant-1', providerID: 'provider-a', modelID: 'shared-model' }
      ),
      createAssistantMessage(
        createTokens({ input: 20 }),
        [createStepFinishPart(createTokens({ input: 20 }), 'step-2', 0.02)],
        { id: 'assistant-2', providerID: 'provider-b', modelID: 'shared-model' }
      ),
    ];

    const usage = getSessionUsage(messages);

    expect(usage.models).toHaveLength(2);
    expect(usage.models.map(model => [model.providerID, model.modelID])).toEqual([
      ['provider-a', 'shared-model'],
      ['provider-b', 'shared-model'],
    ]);
    expect(usage.models[0].tokens).toEqual({ ...zeroUsage, input: 10 });
    expect(usage.models[1].tokens).toEqual({ ...zeroUsage, input: 20 });
  });

  it('distinguishes tuples whose joined provider and model IDs collide on slashes', () => {
    const messages = [
      createAssistantMessage(createTokens({ input: 1 }), [], {
        id: 'assistant-1',
        providerID: 'a/b',
        modelID: 'c',
      }),
      createAssistantMessage(createTokens({ input: 2 }), [], {
        id: 'assistant-2',
        providerID: 'a',
        modelID: 'b/c',
      }),
    ];

    const usage = getSessionUsage(messages);

    expect(usage.models).toHaveLength(2);
    expect(usage.models.map(model => [model.providerID, model.modelID])).toEqual([
      ['a/b', 'c'],
      ['a', 'b/c'],
    ]);
    expect(usage.models[0].tokens).toEqual({ ...zeroUsage, input: 1 });
    expect(usage.models[1].tokens).toEqual({ ...zeroUsage, input: 2 });
  });

  it('sums finished step costs and tokens instead of the assistant snapshot', () => {
    const message = createAssistantMessage(
      createTokens({
        input: 999,
        output: 888,
        reasoning: 777,
        cache: { read: 666, write: 555 },
      }),
      [
        createStepFinishPart(
          createTokens({ input: 10, output: 1, cache: { read: 2, write: 0 } }),
          'step-1',
          0.02
        ),
        createStepFinishPart(
          createTokens({ input: 20, output: 2, cache: { read: 3, write: 1 } }),
          'step-2',
          0.03
        ),
      ],
      { cost: 99 }
    );

    const usage = getSessionUsage([message]);
    const expectedTokens = {
      input: 30,
      output: 3,
      reasoning: 0,
      cacheRead: 5,
      cacheWrite: 1,
    };

    expect(usage.tokens).toEqual(expectedTokens);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0].tokens).toEqual(expectedTokens);
    expect(usage.models[0].costUsd).toBeCloseTo(0.05, 12);
  });

  it('excludes folded child cost from a stepless task wrapper', () => {
    const message = createAssistantMessage(
      createTokens({ input: 7, output: 3 }),
      [createTaskToolPart()],
      { cost: 0.42 }
    );

    const [model] = getSessionUsage([message]).models;

    expect(model.costUsd).toBe(0);
    expect(model.tokens).toEqual({ ...zeroUsage, input: 7, output: 3 });
  });

  it('falls back to assistant cost and tokens when a message has no steps or task tool', () => {
    const message = createAssistantMessage(
      createTokens({ input: 40, output: 2, reasoning: 1 }),
      [createTextPart()],
      { cost: 0.25 }
    );

    const [model] = getSessionUsage([message]).models;

    expect(model.costUsd).toBe(0.25);
    expect(model.tokens).toEqual({ ...zeroUsage, input: 40, output: 2, reasoning: 1 });
  });

  it('sanitizes negative costs and token counts', () => {
    const message = createAssistantMessage(
      createTokens({
        input: -10,
        output: Number.NaN,
        reasoning: Number.POSITIVE_INFINITY,
        cache: { read: -3, write: Number.NEGATIVE_INFINITY },
      }),
      [
        createStepFinishPart(
          createTokens({
            input: -5,
            output: -6,
            reasoning: -7,
            cache: { read: -8, write: -9 },
          }),
          'invalid-step',
          -0.01
        ),
        createStepFinishPart(createTokens({ input: 5, output: 2 }), 'valid-step', 0.02),
      ],
      { cost: -1 }
    );

    const usage = getSessionUsage([message]);

    expect(usage.tokens).toEqual({ ...zeroUsage, input: 5, output: 2 });
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0].tokens).toEqual({ ...zeroUsage, input: 5, output: 2 });
    expect(usage.models[0].costUsd).toBeCloseTo(0.02, 12);
  });

  it.each([
    { label: 'no messages', messages: [] as StoredMessage[] },
    {
      label: 'user-only messages',
      messages: [
        createUserMessage([
          createStepFinishPart(createTokens({ input: 9_000, output: 900 }), 'user-step'),
        ]),
      ],
    },
  ])('returns no model usage for $label', ({ messages }) => {
    expect(getSessionUsage(messages)).toEqual({ tokens: zeroUsage, models: [] });
  });

  it('keeps a zero-cost model in the breakdown', () => {
    const message = createAssistantMessage(
      createTokens({ input: 5 }),
      [createStepFinishPart(createTokens({ input: 5 }), 'step-1', 0)],
      { providerID: 'provider-zero', modelID: 'zero-cost-model' }
    );

    expect(getSessionUsage([message]).models).toEqual([
      {
        providerID: 'provider-zero',
        modelID: 'zero-cost-model',
        costUsd: 0,
        tokens: { ...zeroUsage, input: 5 },
      },
    ]);
  });
});
