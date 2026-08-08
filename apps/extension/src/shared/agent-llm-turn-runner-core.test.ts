/* eslint-disable max-lines, sort-keys, no-promise-executor-return, promise/avoid-new, promise/prefer-await-to-then, jest/no-conditional-in-test -- Retry fixtures need attempt-conditional fakes and raw promises. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSafeToolCall, createUserMessage } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import type { FetchLike } from './auth';
import { maxAgentToolRounds } from './agent-tool-round-limit';
import type { KiloGatewayToolCallRequest } from './kilo-api-client';
import { runLlmTurn } from './agent-llm-turn-runner-core';

const stringBodySchema = z.string();

function* createGatewayResponses(): Generator<Response, Response> {
  yield streamResponse([
    'data: {"choices":[{"delta":{"content":"Reading"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"cost":0.0007}}\n\n',
    'data: [DONE]\n\n',
  ]);
  yield streamResponse([
    'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
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
    'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
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
        'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
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
      tools: [],
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
      tools: [],
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
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
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

  it('never fires onAssistantStreaming when the stream has no content deltas', async () => {
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
    tools: [],
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
          'data: {"choices":[{"delta":{"content":"Recovered."}}]}\n\n',
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
          'data: {"choices":[{"delta":{"content":"Full answer."}}]}\n\n',
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
    // The retry cleared the half-streamed text, then re-streamed into the same event.
    const firstAppendedMessage = appended.find(event => event.type === 'message');
    expect(updates.some(update => update.text === '')).toBe(true);
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
});
