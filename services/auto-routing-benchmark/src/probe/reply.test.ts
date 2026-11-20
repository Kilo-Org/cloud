import { describe, expect, it } from 'vitest';
import { parseProbeStream } from './reply';

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe('probe reply parser — Responses', () => {
  it('counts one function call once across its added, delta and done events', () => {
    const args = JSON.stringify({ command: 'node scripts/verify.js', description: 'Verify' });
    const stream = [
      sse('response.created', {
        response: { id: 'resp_1', created_at: 1, model: 'meta/muse-ember' },
      }),
      sse('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '' },
      }),
      sse('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        output_index: 0,
        delta: args,
      }),
      sse('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'bash',
          arguments: args,
        },
      }),
      sse('response.completed', {
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [],
          usage: { input_tokens: 100, output_tokens: 8, cost: 0.001 },
        },
      }),
    ].join('');

    const reply = parseProbeStream('responses', stream);

    expect(reply.toolCalls).toEqual([{ name: 'bash', arguments: args }]);
    expect(reply.finishReason).toBe('tool-calls');
    expect(reply.terminal).toBe(true);
    expect(reply.costUsd).toBe(0.001);
  });

  it('joins an item first seen by argument deltas, then by its done event', () => {
    const stream = [
      sse('response.function_call_arguments.delta', {
        item_id: 'fc_9',
        output_index: 0,
        delta: '{"command":"ls"',
      }),
      sse('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_9',
          call_id: 'call_9',
          name: 'bash',
          arguments: '{"command":"ls","description":"List"}',
        },
      }),
    ].join('');

    expect(parseProbeStream('responses', stream).toolCalls).toHaveLength(1);
  });

  it('keeps two parallel calls apart', () => {
    const item = (index: number) =>
      sse('response.output_item.done', {
        output_index: index,
        item: {
          type: 'function_call',
          id: `fc_${index}`,
          call_id: `call_${index}`,
          name: 'bash',
          arguments: `{"command":"echo ${index}"}`,
        },
      });
    const reply = parseProbeStream('responses', [item(0), item(1)].join(''));

    expect(reply.toolCalls.map(call => call.arguments)).toEqual([
      '{"command":"echo 0"}',
      '{"command":"echo 1"}',
    ]);
  });
});

describe('probe reply parser — chat', () => {
  it('keeps the tool name a later argument chunk leaves empty', () => {
    // Shape the gateway served for deepseek: the name arrives once, then every argument
    // chunk repeats `"name": ""`.
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({
        id: '2c1ddaeb9f53423e80ae3b5d3950d586',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { ...delta, index: 0, content: '' }, finish_reason: null }],
        ...extra,
      })}\n\n`;
    const stream = [
      chunk({ role: 'assistant' }),
      chunk({
        tool_calls: [
          { id: 'tool_1', type: 'function', function: { name: 'bash', arguments: '' }, index: 0 },
        ],
      }),
      chunk({
        tool_calls: [{ function: { name: '', arguments: '{"command": "cat data' }, index: 0 }],
      }),
      chunk({ tool_calls: [{ function: { name: '', arguments: '/invoices.csv"}' }, index: 0 }] }),
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { index: 0, content: '' }, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 17138,
          completion_tokens: 86,
          prompt_tokens_details: { cached_tokens: 2176 },
          completion_tokens_details: { reasoning_tokens: 0 },
          cost: 0.004607,
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    const reply = parseProbeStream('chat', stream);

    expect(reply.toolCalls).toEqual([
      { name: 'bash', arguments: '{"command": "cat data/invoices.csv"}' },
    ]);
    expect(reply.finishReason).toBe('tool-calls');
    expect(reply.inputTokens).toBe(17138);
    expect(reply.cachedInputTokens).toBe(2176);
    expect(reply.outputTokens).toBe(86);
    expect(reply.costUsd).toBe(0.004607);
  });
});

describe('probe reply parser — Anthropic Messages', () => {
  it('reads a tool_use block, its input fragments and the token usage', () => {
    const partial = JSON.stringify({ command: 'node scripts/verify.js', description: 'Verify' });
    const stream = [
      sse('message_start', {
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 4000, output_tokens: 1 },
        },
      }),
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
      }),
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: partial },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', {
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 12 },
      }),
      sse('message_stop', {}),
    ].join('');

    const reply = parseProbeStream('anthropic', stream);

    expect(reply.toolCalls).toEqual([{ name: 'bash', arguments: partial }]);
    expect(reply.finishReason).toBe('tool-calls');
    expect(reply.inputTokens).toBe(4000);
    expect(reply.outputTokens).toBe(12);
    expect(reply.terminal).toBe(true);
  });

  it('takes the input and cache counts the closing usage reports', () => {
    // Shape the gateway served for claude-haiku-5.5: `message_start` carries zeros and the
    // closing `message_delta` carries the message's real input, cache writes and thinking.
    const stream = [
      sse('message_start', {
        message: {
          id: 'gen_01M7',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        },
      }),
      sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Look' } }),
      sse('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
      }),
      sse('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      }),
      sse('message_delta', {
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: {
          input_tokens: 2,
          output_tokens: 193,
          cache_creation_input_tokens: 24802,
          output_tokens_details: { thinking_tokens: 62 },
          cost: 0.003197,
        },
      }),
      sse('message_stop', {}),
    ].join('');

    const reply = parseProbeStream('anthropic', stream);

    expect(reply.inputTokens).toBe(24804);
    expect(reply.cachedInputTokens).toBeNull();
    expect(reply.outputTokens).toBe(193);
    expect(reply.reasoningTokens).toBe(62);
    expect(reply.costUsd).toBe(0.003197);
    expect(reply.toolCalls).toEqual([{ name: 'bash', arguments: '{"command":"ls"}' }]);
    expect(reply.finishReason).toBe('tool-calls');
  });

  it('scores narration and a cut stream apart', () => {
    const narration = [
      sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: "I'll inspect the data next." },
      }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }),
      sse('message_stop', {}),
    ].join('');
    const parsed = parseProbeStream('anthropic', narration);
    expect(parsed.text).toBe("I'll inspect the data next.");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.finishReason).toBe('stop');

    const cut = parseProbeStream(
      'anthropic',
      sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    );
    expect(cut.terminal).toBe(false);
  });
});
