/* eslint-disable max-lines */
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
