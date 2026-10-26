import { describe, expect, it } from '@jest/globals';
import type {
  AssistantMessage,
  Part,
  StepFinishPart,
  StoredMessage,
  UserMessage,
} from '@kilocode/cloud-agent-sdk';
import { getSessionTokenUsage } from './session-token-usage';

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
    cost: 0,
    tokens,
    ...(options.error ? { error: options.error } : {}),
  };

  return { info, parts };
}

function createStepFinishPart(tokens: TokenCounts, id = 'step-1'): StepFinishPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens,
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
