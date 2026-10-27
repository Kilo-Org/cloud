import { describe, expect, test } from '@jest/globals';
import {
  parseMicrodollarUsageFromStream,
  parseMicrodollarUsageFromString,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import {
  parseResponsesMicrodollarUsageFromStream,
  parseResponsesMicrodollarUsageFromString,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.responses';
import {
  parseMessagesMicrodollarUsageFromStream,
  parseMessagesMicrodollarUsageFromString,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.messages';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('tool-call argument assembly', () => {
  test('chat completions stream joins argument deltas per tool call', async () => {
    const chunk = (toolCalls: unknown[], content?: string) => ({
      id: 'chatcmpl-1',
      model: 'openai/gpt-4.1',
      choices: [{ index: 0, delta: { content, tool_calls: toolCalls } }],
    });
    const result = await parseMicrodollarUsageFromStream(
      sseStream([
        chunk([], 'Reading files'),
        chunk([{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } }]),
        chunk([{ index: 1, id: 'b', function: { name: 'read', arguments: '{"path":"b"}' } }]),
        chunk([{ index: 0, function: { arguments: '"a"}' } }]),
      ]),
      'user-1',
      undefined,
      'openrouter',
      200,
      false
    );
    expect(result.responseContent).toBe('Reading files');
    expect(result.toolCallArguments).toBe('{"path":"a"}\n{"path":"b"}');
  });

  test('chat completions JSON reads function and custom tool calls', () => {
    const result = parseMicrodollarUsageFromString(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'openai/gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'a', type: 'function', function: { name: 'read', arguments: '{"x":1}' } },
                { id: 'b', type: 'custom', custom: { name: 'patch', input: '*** Begin Patch' } },
              ],
            },
          },
        ],
      }),
      'user-1',
      200,
      'openrouter'
    );
    expect(result.toolCallArguments).toBe('{"x":1}\n*** Begin Patch');
  });

  test('chat completions JSON accepts tool calls without a type, as Mistral sends them', () => {
    const result = parseMicrodollarUsageFromString(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'mistralai/devstral',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'a', function: { name: 'read', arguments: '{"x":1}' } },
                { id: 'b' },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0, is_byok: false },
      }),
      'user-1',
      200,
      'openrouter'
    );
    expect(result.toolCallArguments).toBe('{"x":1}');
    expect(result.inputTokens).toBe(1);
  });

  test('responses stream reads completed function and custom tool call items', async () => {
    const result = await parseResponsesMicrodollarUsageFromStream(
      sseStream([
        { type: 'response.output_text.delta', delta: 'Sure' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'a', name: 'read', arguments: '{"x":1}' },
        },
        {
          type: 'response.output_item.done',
          item: { type: 'custom_tool_call', call_id: 'b', name: 'patch', input: 'diff' },
        },
        {
          type: 'response.output_item.done',
          item: { type: 'message', role: 'assistant', content: [] },
        },
      ]),
      'user-1',
      undefined,
      'openrouter',
      200,
      false
    );
    expect(result.responseContent).toBe('Sure');
    expect(result.toolCallArguments).toBe('{"x":1}\ndiff');
  });

  test('responses JSON reads tool call output items', () => {
    const result = parseResponsesMicrodollarUsageFromString(
      JSON.stringify({
        id: 'resp-1',
        model: 'openai/gpt-5',
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
          { type: 'function_call', call_id: 'a', name: 'read', arguments: '{"x":1}' },
        ],
      }),
      200,
      'openrouter'
    );
    expect(result.responseContent).toBe('Hi');
    expect(result.toolCallArguments).toBe('{"x":1}');
  });

  test('messages stream joins input_json_delta fragments per content block', async () => {
    const result = await parseMessagesMicrodollarUsageFromStream(
      sseStream([
        {
          type: 'message_start',
          message: { id: 'msg-1', model: 'claude', usage: { input_tokens: 1, output_tokens: 1 } },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ok' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"a"' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: ':1}' },
        },
      ]),
      'user-1',
      undefined,
      'openrouter',
      200,
      false
    );
    expect(result.responseContent).toBe('Ok');
    expect(result.toolCallArguments).toBe('{"a":1}\n{}');
  });

  test('messages JSON serializes tool_use input', () => {
    const result = parseMessagesMicrodollarUsageFromString(
      JSON.stringify({
        id: 'msg-1',
        model: 'claude',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Ok' },
          { type: 'tool_use', id: 't', name: 'read', input: { path: 'a' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      200,
      'openrouter'
    );
    expect(result.toolCallArguments).toBe('{"path":"a"}');
  });
});
