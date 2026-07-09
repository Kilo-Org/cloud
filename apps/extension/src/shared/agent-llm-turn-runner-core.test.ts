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
    'data: [DONE]\n\n',
  ]);
  yield streamResponse([
    'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
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
        'data: {"choices":[],"usage":{"completion_tokens":5,"prompt_tokens":999,"total_tokens":1004}}\n\n',
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
      promptTokens: 999,
    });
  });

  it('streams, runs tools, and continues with tool results', async () => {
    const appendedEvents: AgentConversationEvent[] = [];
    const updatedMessages: string[] = [];
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
  });

  it('allows twenty tool rounds before asking the user to continue', async () => {
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

    expect(appendedEvents.filter(event => event.type === 'tool-result')).toHaveLength(20);
    expect(appendedEvents.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Too many tool rounds.',
      type: 'message',
    });
  });
});
