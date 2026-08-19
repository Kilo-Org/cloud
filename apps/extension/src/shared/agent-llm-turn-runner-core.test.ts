/* eslint-disable max-lines, sort-keys, no-promise-executor-return, promise/avoid-new, promise/prefer-await-to-then, jest/no-conditional-in-test, consistent-type-imports, jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- Retry fixtures need attempt-conditional fakes and raw promises; the typed stream-client mock needs importOriginal. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSafeToolCall, createUserMessage } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import type { FetchLike } from './auth';
import { maxAgentToolRounds } from './agent-tool-round-limit';
import type {
  KiloGatewayChatCompletion,
  KiloGatewayToolCallRequest,
  KiloGatewayToolDefinition,
} from './kilo-api-client';
import { runLlmTurn } from './agent-llm-turn-runner-core';

const kiloApiClientMocks = vi.hoisted(() => ({
  fetchKiloGatewayChatCompletionStream: vi.fn(),
}));

// Delegate to the real stream client by default so existing tests are unaffected; the prepareTools tests override per-call.
vi.mock('./kilo-api-client', async importOriginal => {
  const actual = await importOriginal<typeof import('./kilo-api-client')>();
  kiloApiClientMocks.fetchKiloGatewayChatCompletionStream.mockImplementation(
    actual.fetchKiloGatewayChatCompletionStream
  );
  return {
    ...actual,
    fetchKiloGatewayChatCompletionStream: kiloApiClientMocks.fetchKiloGatewayChatCompletionStream,
  };
});

const stringBodySchema = z.string();

// The stream gate validates streamed tool-call names against the offered `tools` set.
// Fixtures stream a `get_page_snapshot` call, so the offered set must include that name.
const getPageSnapshotTool: KiloGatewayToolDefinition = {
  function: {
    description: 'Read a bounded, sanitized snapshot of the selected browser tab.',
    name: 'get_page_snapshot',
    parameters: { type: 'object' },
  },
  type: 'function',
};

function* createGatewayResponses(): Generator<Response, Response> {
  yield streamResponse([
    'data: {"choices":[{"delta":{"content":"Reading"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"cost":0.0007}}\n\n',
    'data: [DONE]\n\n',
  ]);
  yield streamResponse([
    'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":3,"total_tokens":203,"cost":0.001}}\n\n',
    'data: [DONE]\n\n',
  ]);
  return streamResponse(['data: [DONE]\n\n']);
}

function* createToolOnlyGatewayResponses(rounds: number): Generator<Response, Response> {
  for (let index = 0; index < rounds; index += 1) {
    yield streamResponse([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot_${index}","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]}}]}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }

  return streamResponse([
    'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
}

const streamResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        controller.close();
      },
    }),
    {
      headers: { 'Content-Type': 'text/event-stream' },
      status: 200,
    }
  );
};

describe('agent LLM turn runner core', () => {
  it('forwards completion usage to onUsage', async () => {
    const usageCalls: unknown[] = [];
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"completion_tokens":5,"prompt_tokens":999,"total_tokens":1004,"cost":0.0123}}\n\n',
        'data: [DONE]\n\n',
      ]);

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: () => {},
      conversationEvents: [createUserMessage('Hello')],
      executeToolCall: () => Promise.resolve({ ok: true, value: { text: '' } }),
      failureMessage: String,
      fetch,
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      onUsage: usage => usageCalls.push(usage),
      signal: undefined,
      toToolCallEvents: () => [],
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many rounds.',
      tools: [],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(usageCalls).toContainEqual({
      costUsd: 0.0123,
      promptTokens: 999,
    });
  });

  it('streams, runs tools, and continues with tool results', async () => {
    const appendedEvents: AgentConversationEvent[] = [];
    const updatedMessages: string[] = [];
    const usageCalls: unknown[] = [];
    const fetchCalls: unknown[] = [];
    const responses = createGatewayResponses();
    const fetch: FetchLike = (_input, init) => {
      fetchCalls.push(JSON.parse(stringBodySchema.parse(init?.body)));

      return responses.next().value;
    };

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: events => {
        appendedEvents.push(...events);
      },
      conversationEvents: [createUserMessage('Inspect this page')],
      executeToolCall: () => Promise.resolve({ ok: true, value: { text: 'Page text' } }),
      failureMessage: String,
      fetch,
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'The model did not return a response.',
      onUsage: usage => usageCalls.push(usage),
      signal: undefined,
      toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) =>
        toolCalls.map(toolCall =>
          createSafeToolCall({
            name: 'get_page_snapshot',
            providerToolCallId: toolCall.id,
            tabId: 123,
          })
        ),
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many tool rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: (_eventId, text) => {
        updatedMessages.push(text);
      },
      updateThinkingBlock: () => {},
    });

    expect(updatedMessages).toStrictEqual([]);
    expect(appendedEvents.map(event => event.type)).toStrictEqual([
      'message',
      'tool-call',
      'tool-result',
      'message',
    ]);
    expect(appendedEvents).toMatchObject([
      { role: 'assistant', text: 'Reading', type: 'message' },
      {
        name: 'get_page_snapshot',
        providerToolCallId: 'call_snapshot',
        tabId: 123,
        type: 'tool-call',
      },
      { ok: true, type: 'tool-result', value: { text: 'Page text' } },
      { role: 'assistant', text: 'Done.', type: 'message' },
    ]);
    expect(fetchCalls).toHaveLength(2);
    expect(usageCalls).toStrictEqual([
      { costUsd: 0.0007, promptTokens: 100 },
      { costUsd: 0.001, promptTokens: 200 },
    ]);
  });

  it('allows the shared maxAgentToolRounds tool rounds before asking the user to continue', async () => {
    const appendedEvents: AgentConversationEvent[] = [];
    const responses = createToolOnlyGatewayResponses(maxAgentToolRounds);
    const fetch: FetchLike = () => responses.next().value;

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: events => {
        appendedEvents.push(...events);
      },
      conversationEvents: [createUserMessage('Inspect this page')],
      executeToolCall: () => Promise.resolve({ ok: true, value: { text: 'Page text' } }),
      failureMessage: String,
      fetch,
      maxToolRounds: maxAgentToolRounds,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'The model did not return a response.',
      signal: undefined,
      toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) =>
        toolCalls.map(toolCall =>
          createSafeToolCall({
            name: 'get_page_snapshot',
            providerToolCallId: toolCall.id,
            tabId: 123,
          })
        ),
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many tool rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(appendedEvents.filter(event => event.type === 'tool-result')).toHaveLength(
      maxAgentToolRounds
    );
    expect(appendedEvents.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Too many tool rounds.',
      type: 'message',
    });
  });

  it('fires onAssistantStreaming with the event id at first content delta and undefined when the stream resolves', async () => {
    const streamingCalls: (string | undefined)[] = [];
    const appendedEvents: AgentConversationEvent[] = [];
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: events => {
        appendedEvents.push(...events);
      },
      conversationEvents: [createUserMessage('Hi')],
      executeToolCall: () => Promise.resolve({ ok: true, value: { text: '' } }),
      failureMessage: String,
      fetch,
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      onAssistantStreaming: eventId => {
        streamingCalls.push(eventId);
      },
      signal: undefined,
      toToolCallEvents: () => [],
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many rounds.',
      tools: [],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    const assistantMessages = appendedEvents.filter(
      (event): event is Extract<AgentConversationEvent, { type: 'message' }> =>
        event.type === 'message'
    );
    expect(assistantMessages).toHaveLength(1);
    expect(streamingCalls).toHaveLength(2);
    expect(streamingCalls[0]).toBe(assistantMessages[0]?.id);
    expect(streamingCalls[1]).toBeUndefined();
  });

  it('fires onAssistantStreaming undefined via try/finally when the stream rejects after a start', async () => {
    const streamingCalls: (string | undefined)[] = [];
    const encoder = new TextEncoder();
    // Pull 1 delivers a content delta (starts streaming); pull 2 errors the stream.
    // Array dispatch avoids controller.error wiping an already-enqueued chunk before the first read.
    const pullActions: ((controller: ReadableStreamDefaultController<Uint8Array>) => void)[] = [
      controller => {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n')
        );
      },
      controller => {
        controller.error(new Error('network dropped'));
      },
    ];
    let pullIndex = 0;
    const fetch: FetchLike = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pullActions[pullIndex]?.(controller);
            pullIndex += 1;
          },
        }),
        {
          headers: { 'Content-Type': 'text/event-stream' },
          status: 200,
        }
      );

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: () => {},
      conversationEvents: [createUserMessage('Hi')],
      executeToolCall: () => Promise.resolve({ ok: true, value: { text: '' } }),
      failureMessage: String,
      fetch,
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      onAssistantStreaming: eventId => {
        streamingCalls.push(eventId);
      },
      signal: undefined,
      toToolCallEvents: () => [],
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many rounds.',
      tools: [],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(streamingCalls).toHaveLength(2);
    const [startedId, endedId] = streamingCalls;
    expect(startedId).toBeDefined();
    expect(startedId).not.toBe('');
    expect(endedId).toBeUndefined();
  });

  it(
    'never fires onAssistantStreaming when the stream has no content deltas',
    { timeout: 20_000 },
    async () => {
      const streamingCalls: (string | undefined)[] = [];
      // Empty stream: no onContentDelta calls, so the non-streamed start path never runs.
      // Deltas absent means the defensive completion.content branch is not exercised here;
      // The public stream client never produces content without deltas.
      const fetch: FetchLike = () => streamResponse(['data: [DONE]\n\n']);

      await runLlmTurn({
        apiBaseUrl: 'https://app.kilo.ai',
        appendEvents: () => {},
        conversationEvents: [createUserMessage('Hi')],
        executeToolCall: () => Promise.resolve({ ok: true, value: { text: '' } }),
        failureMessage: String,
        fetch,
        maxToolRounds: 4,
        model: 'anthropic/claude-sonnet-4',
        noResponseMessage: 'No response.',
        onAssistantStreaming: eventId => {
          streamingCalls.push(eventId);
        },
        signal: undefined,
        toToolCallEvents: () => [],
        token: 'token-1',
        tooManyToolRoundsMessage: 'Too many rounds.',
        tools: [],
        updateAssistantMessage: () => {},
        updateThinkingBlock: () => {},
      });

      expect(streamingCalls).toStrictEqual([]);
    }
  );
});

describe('prepareTools', () => {
  const preparedTools: KiloGatewayToolDefinition[] = [
    {
      function: {
        description: 'A tool supplied by prepareTools.',
        name: 'get_page_snapshot',
        parameters: { type: 'object' },
      },
      type: 'function',
    },
  ];

  it('calls prepareTools before the gateway request and sends its returned tools', async () => {
    const capturedTools: KiloGatewayToolDefinition[][] = [];
    let prepareCallCount = 0;

    kiloApiClientMocks.fetchKiloGatewayChatCompletionStream.mockImplementationOnce(
      (options: { tools: KiloGatewayToolDefinition[] }) => {
        capturedTools.push(options.tools);
        return {
          content: 'Done.',
          finishReason: 'stop',
          toolCalls: [],
        } satisfies KiloGatewayChatCompletion;
      }
    );

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: () => {},
      conversationEvents: [createUserMessage('Hello')],
      executeToolCall: () => Promise.resolve({ ok: true, value: {} }),
      failureMessage: String,
      fetch: () => Promise.resolve(new Response('', { status: 500 })),
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      prepareTools: () => {
        prepareCallCount += 1;
        return Promise.resolve(preparedTools);
      },
      signal: undefined,
      toToolCallEvents: () => [],
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(prepareCallCount).toBe(1);
    expect(capturedTools).toStrictEqual([preparedTools]);
  });

  it('awaits prepareTools on both attempts and sends each attempt its returned tools', async () => {
    const capturedTools: KiloGatewayToolDefinition[][] = [];
    let prepareCallCount = 0;
    const firstList: KiloGatewayToolDefinition[] = [
      {
        function: {
          description: 'First attempt tool list.',
          name: 'get_page_snapshot',
          parameters: { type: 'object' },
        },
        type: 'function',
      },
    ];
    const secondList: KiloGatewayToolDefinition[] = [
      {
        function: {
          description: 'Second attempt tool list.',
          name: 'get_page_snapshot',
          parameters: { type: 'object' },
        },
        type: 'function',
      },
    ];

    // First attempt fails with a retriable network error; the retry succeeds.
    kiloApiClientMocks.fetchKiloGatewayChatCompletionStream.mockImplementationOnce(
      (options: { tools: KiloGatewayToolDefinition[] }) => {
        capturedTools.push(options.tools);
        throw new TypeError('Failed to fetch');
      }
    );
    kiloApiClientMocks.fetchKiloGatewayChatCompletionStream.mockImplementationOnce(
      (options: { tools: KiloGatewayToolDefinition[] }) => {
        capturedTools.push(options.tools);
        return {
          content: 'Done.',
          finishReason: 'stop',
          toolCalls: [],
        } satisfies KiloGatewayChatCompletion;
      }
    );

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: () => {},
      conversationEvents: [createUserMessage('Hello')],
      executeToolCall: () => Promise.resolve({ ok: true, value: {} }),
      failureMessage: String,
      fetch: () => Promise.resolve(new Response('', { status: 500 })),
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      prepareTools: () => {
        prepareCallCount += 1;
        return Promise.resolve(prepareCallCount === 1 ? firstList : secondList);
      },
      signal: undefined,
      toToolCallEvents: () => [],
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(prepareCallCount).toBe(2);
    expect(capturedTools).toStrictEqual([firstList, secondList]);
  });

  it('uses the fixed tools array when prepareTools is undefined', async () => {
    const capturedTools: KiloGatewayToolDefinition[][] = [];

    kiloApiClientMocks.fetchKiloGatewayChatCompletionStream.mockImplementationOnce(
      (options: { tools: KiloGatewayToolDefinition[] }) => {
        capturedTools.push(options.tools);
        return {
          content: 'Done.',
          finishReason: 'stop',
          toolCalls: [],
        } satisfies KiloGatewayChatCompletion;
      }
    );

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: () => {},
      conversationEvents: [createUserMessage('Hello')],
      executeToolCall: () => Promise.resolve({ ok: true, value: {} }),
      failureMessage: String,
      fetch: () => Promise.resolve(new Response('', { status: 500 })),
      maxToolRounds: 4,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      signal: undefined,
      toToolCallEvents: () => [],
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(capturedTools).toStrictEqual([[getPageSnapshotTool]]);
  });
});

describe('stream retry', () => {
  const baseOptions = (
    fetch: FetchLike,
    appendEvents: (events: AgentConversationEvent[]) => void
  ) => ({
    apiBaseUrl: 'https://app.kilo.ai',
    appendEvents,
    conversationEvents: [createUserMessage('Hello')],
    executeToolCall: () => Promise.resolve({ ok: true as const, value: { text: '' } }),
    failureMessage: (error: unknown) =>
      `failed: ${error instanceof Error ? error.message : String(error)}`,
    fetch,
    maxToolRounds: 4,
    model: 'kilo-auto/efficient',
    noResponseMessage: 'no response',
    toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) =>
      toolCalls.flatMap(toolCall =>
        toolCall.name === 'get_page_snapshot'
          ? [
              createSafeToolCall({
                name: 'get_page_snapshot',
                tabId: 1,
                providerToolCallId: toolCall.id,
              }),
            ]
          : []
      ),
    token: 'token',
    tooManyToolRoundsMessage: 'too many rounds',
    tools: [getPageSnapshotTool],
    updateAssistantMessage: () => {},
    updateThinkingBlock: () => {},
  });

  it('retries a 503 response transparently and completes the turn', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Recovered."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };
    const appended: AgentConversationEvent[] = [];

    await runLlmTurn(baseOptions(fetch, events => appended.push(...events)));

    expect(calls).toBe(2);
    const texts = appended.flatMap(event => (event.type === 'message' ? [event.text] : []));
    expect(texts).toContain('Recovered.');
    expect(texts.some(text => text.startsWith('failed:'))).toBe(false);
  });

  it('resets partially streamed text into the same event on retry', async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        // Streams one delta, then fails mid-stream with a network-ish TypeError.
        // The delay lets the delta reach the consumer before the error lands.
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"Half"}}]}\n\n')
                );
                await new Promise(resolve => setTimeout(resolve, 20));
                controller.error(new TypeError('network glitch'));
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
          )
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Full answer."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };
    const appended: AgentConversationEvent[] = [];
    const updates: { id: string; text: string }[] = [];
    const options = {
      ...baseOptions(fetch, events => appended.push(...events)),
      updateAssistantMessage: (eventId: string, text: string) => {
        updates.push({ id: eventId, text });
      },
    };

    await runLlmTurn(options);

    expect(calls).toBe(2);
    // The retry replaces the half-streamed text in place when its own first delta arrives; the text is never cleared to an empty bubble.
    const firstAppendedMessage = appended.find(event => event.type === 'message');
    expect(updates.some(update => update.text === '')).toBe(false);
    expect(updates.at(-1)?.text).toBe('Full answer.');
    expect(updates.every(update => update.id === firstAppendedMessage?.id)).toBe(true);
  });

  it('gives up after three attempts and reports the failure', { timeout: 15_000 }, async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('', { status: 503 }));
    };
    const appended: AgentConversationEvent[] = [];

    await runLlmTurn(baseOptions(fetch, events => appended.push(...events)));

    expect(calls).toBe(3);
    const texts = appended.flatMap(event => (event.type === 'message' ? [event.text] : []));
    expect(texts.some(text => text.startsWith('failed:'))).toBe(true);
  });

  it('does not retry a non-retriable HTTP status', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('', { status: 401 }));
    };
    const appended: AgentConversationEvent[] = [];

    await runLlmTurn(baseOptions(fetch, events => appended.push(...events)));

    expect(calls).toBe(1);
    const texts = appended.flatMap(event => (event.type === 'message' ? [event.text] : []));
    expect(texts.some(text => text.startsWith('failed:'))).toBe(true);
  });
});

describe('truncated completion retry', () => {
  it('retries a completion cut short by finish_reason length with no tool calls', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"content":"Creating"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Saved the workflow."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };
    const appended: AgentConversationEvent[] = [];
    const updates: string[] = [];
    const options = {
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: (events: AgentConversationEvent[]) => appended.push(...events),
      conversationEvents: [createUserMessage('Create a workflow')],
      executeToolCall: () => Promise.resolve({ ok: true as const, value: {} }),
      failureMessage: (error: unknown) =>
        `failed: ${error instanceof Error ? error.message : String(error)}`,
      fetch,
      maxToolRounds: 4,
      model: 'kilo-auto/efficient',
      noResponseMessage: 'no response',
      token: 'token',
      tools: [],
      tooManyToolRoundsMessage: 'too many rounds',
      toToolCallEvents: () => [],
      updateAssistantMessage: (_eventId: string, text: string) => {
        updates.push(text);
      },
      updateThinkingBlock: () => {},
    };

    await runLlmTurn(options);

    expect(calls).toBe(2);
    expect(updates.at(-1)).toBe('Saved the workflow.');
    const texts = appended.flatMap(event => (event.type === 'message' ? [event.text] : []));
    expect(texts.some(text => text.startsWith('failed:'))).toBe(false);
  });

  it('does not retry a completion that stopped normally', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"All done."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };
    const appended: AgentConversationEvent[] = [];

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: (events: AgentConversationEvent[]) => appended.push(...events),
      conversationEvents: [createUserMessage('Hello')],
      executeToolCall: () => Promise.resolve({ ok: true as const, value: {} }),
      failureMessage: String,
      fetch,
      maxToolRounds: 4,
      model: 'kilo-auto/efficient',
      noResponseMessage: 'no response',
      token: 'token',
      tools: [],
      tooManyToolRoundsMessage: 'too many rounds',
      toToolCallEvents: () => [],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    expect(calls).toBe(1);
  });

  it('does not retry a context-window overflow and keeps the partial text', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Partial answer before the overflow"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"model_context_window_exceeded"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };
    const appended: AgentConversationEvent[] = [];

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: (events: AgentConversationEvent[]) => appended.push(...events),
      conversationEvents: [createUserMessage('Hello')],
      executeToolCall: () => Promise.resolve({ ok: true as const, value: {} }),
      failureMessage: (error: unknown) =>
        `failed: ${error instanceof Error ? error.message : String(error)}`,
      fetch,
      maxToolRounds: 4,
      model: 'kilo-auto/efficient',
      noResponseMessage: 'no response',
      token: 'token',
      tools: [],
      tooManyToolRoundsMessage: 'too many rounds',
      toToolCallEvents: () => [],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    // A prompt that overflowed the context cannot fit on a retry of the same messages; one billed attempt, degrade immediately.
    expect(calls).toBe(1);
    const texts = appended.flatMap(event => (event.type === 'message' ? [event.text] : []));
    expect(texts).toContain('Partial answer before the overflow');
    expect(texts.some(text => text.startsWith('failed:'))).toBe(false);
  });
});

describe('identical failing tool call guard', () => {
  it('escalates the third identical failure and leaves earlier ones untouched', async () => {
    const appendedEvents: AgentConversationEvent[] = [];
    const responses = createToolOnlyGatewayResponses(4);
    const fetch: FetchLike = () => responses.next().value;

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: events => {
        appendedEvents.push(...events);
      },
      conversationEvents: [createUserMessage('Run the workflow')],
      executeToolCall: () => Promise.resolve({ error: 'Workflow run failed', ok: false }),
      failureMessage: String,
      fetch,
      maxToolRounds: 8,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      onUsage: () => {},
      signal: undefined,
      toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) =>
        toolCalls.map(toolCall => ({
          ...createSafeToolCall({
            name: 'get_page_snapshot',
            providerToolCallId: toolCall.id,
            tabId: 123,
          }),
          // Varies per round, like signed reasoning on a thinking model; the guard must still see identical repeats.
          reasoningDetails: [toolCall.id],
        })),
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many tool rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    const failureTexts = appendedEvents
      .filter(event => event.type === 'tool-result')
      .map(event => JSON.stringify(event));
    const escalated = failureTexts.map(text => text.includes('Do not send it again'));
    expect(failureTexts).toHaveLength(4);
    expect(escalated).toStrictEqual([false, false, true, true]);
    expect(failureTexts[3]).toContain('4 times');
  });
});

describe('per-tool failure cap', () => {
  it('ends the turn after 25 total failures of one tool, despite interleaved successes', async () => {
    const appendedEvents: AgentConversationEvent[] = [];
    let fetchCount = 0;
    const responses = createToolOnlyGatewayResponses(40);
    const fetch: FetchLike = () => {
      fetchCount += 1;
      return responses.next().value;
    };
    let callIndex = 0;

    await runLlmTurn({
      apiBaseUrl: 'https://app.kilo.ai',
      appendEvents: events => {
        appendedEvents.push(...events);
      },
      conversationEvents: [createUserMessage('Run the workflow')],
      // The error varies per call (the cap counts per tool name, not identical bytes), and every tenth call succeeds (an interleaved success must not reset the total).
      executeToolCall: () => {
        callIndex += 1;
        if (callIndex % 10 === 0) {
          return Promise.resolve({ ok: true, value: { text: 'ok' } });
        }
        return Promise.resolve({ error: `failure ${String(callIndex)}`, ok: false });
      },
      failureMessage: String,
      fetch,
      maxToolRounds: 40,
      model: 'anthropic/claude-sonnet-4',
      noResponseMessage: 'No response.',
      onUsage: () => {},
      signal: undefined,
      toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) =>
        toolCalls.map(toolCall =>
          createSafeToolCall({
            name: 'get_page_snapshot',
            providerToolCallId: toolCall.id,
            tabId: 123,
          })
        ),
      token: 'token-1',
      tooManyToolRoundsMessage: 'Too many tool rounds.',
      tools: [getPageSnapshotTool],
      updateAssistantMessage: () => {},
      updateThinkingBlock: () => {},
    });

    // 25 failures plus the 2 interleaved successes (calls 10 and 20) = 27 rounds.
    expect(fetchCount).toBe(27);
    const lastEvent = appendedEvents.at(-1);
    expect(JSON.stringify(lastEvent)).toContain(
      'Stopped: get_page_snapshot failed 25 times this turn'
    );
  });
});

describe('continue nudge', () => {
  const nudgeOptions = (fetch: FetchLike, appended: AgentConversationEvent[]) => ({
    apiBaseUrl: 'https://app.kilo.ai',
    appendEvents: (events: AgentConversationEvent[]) => appended.push(...events),
    conversationEvents: [createUserMessage('Create a workflow for this page')],
    executeToolCall: () => Promise.resolve({ ok: true as const, value: { text: 'snap' } }),
    failureMessage: String,
    fetch,
    maxToolRounds: 6,
    model: 'kilo-auto/efficient',
    noResponseMessage: 'no response',
    token: 'token',
    tools: [getPageSnapshotTool],
    tooManyToolRoundsMessage: 'too many rounds',
    toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) =>
      toolCalls.flatMap(toolCall =>
        toolCall.name === 'get_page_snapshot'
          ? [
              createSafeToolCall({
                name: 'get_page_snapshot',
                providerToolCallId: toolCall.id,
                tabId: 1,
              }),
            ]
          : []
      ),
    updateAssistantMessage: () => {},
    updateThinkingBlock: () => {},
  });

  it('sends one invisible continue after a tool-using turn ends on a short announcement', async () => {
    const requestBodies: string[] = [];
    let calls = 0;
    const fetch: FetchLike = (_input, init) => {
      requestBodies.push(typeof init?.body === 'string' ? init.body : '');
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      if (calls === 2) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"content":"Creating the workflow now."},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Saved and verified."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };
    const appended: AgentConversationEvent[] = [];

    await runLlmTurn(nudgeOptions(fetch, appended));

    expect(calls).toBe(3);
    expect(requestBodies[2]).toContain('Continue: finish the request now');
    const appendedTexts = appended.flatMap(event => (event.type === 'message' ? [event.text] : []));
    expect(appendedTexts).toContain('Saved and verified.');
    // The nudge is never persisted as a visible message.
    expect(appendedTexts.some(text => text.includes('Continue: finish the request'))).toBe(false);
  });

  it('nudges a turn that ends on thinking with no assistant text', async () => {
    const requestBodies: string[] = [];
    let calls = 0;
    const fetch: FetchLike = (_input, init) => {
      requestBodies.push(typeof init?.body === 'string' ? init.body : '');
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      if (calls === 2) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"reasoning":"The user wants a workflow. I should look at the page."},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Saved."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(3);
    expect(requestBodies[2]).toContain('Continue: finish the request now');
  });

  it('nudges a thinking-only end even before any tool use', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"reasoning":"Planning the workflow…"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Here is the workflow plan."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(2);
  });

  it('does not nudge a plain text answer with no tool use', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Short answer."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(1);
  });

  it("nudges on a first-person progressive announcement (I'm creating…)", async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      if (calls === 2) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"content":"I\'m saving it as a reusable flow now."},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Saved."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(3);
  });

  it('does not nudge a completed-work statement (I am done)', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"I am done. Nothing else is needed."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(2);
  });

  it('does not nudge when the model asks the user a question', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Which date should I use?"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(2);
  });

  it('does not nudge an announcement that ended on a context-window overflow', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Creating the workflow now."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"model_context_window_exceeded"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    // The prompt already overflowed; a nudge re-sends it plus one more message, a guaranteed second overflow.
    expect(calls).toBe(2);
  });

  it('nudges an announcement that mentions a URL query string (mid-text ?)', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snap","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      if (calls === 2) {
        return Promise.resolve(
          streamResponse([
            'data: {"choices":[{"delta":{"content":"The search uses https://example.com/search?q=. Let me verify the results page before creating the workflow."},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ])
        );
      }
      return Promise.resolve(
        streamResponse([
          'data: {"choices":[{"delta":{"content":"Saved."},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      );
    };

    await runLlmTurn(nudgeOptions(fetch, []));

    expect(calls).toBe(3);
  });
});
