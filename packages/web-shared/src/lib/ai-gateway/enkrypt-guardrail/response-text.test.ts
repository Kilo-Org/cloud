import { describe, expect, it } from '@jest/globals';
import { extractResponseText } from './response-text';

function sse(events: unknown[]) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function chatStream(chunks: unknown[]) {
  return `${sse(chunks)}data: [DONE]\n\n`;
}

function typedSse(events: Array<{ type: string; [key: string]: unknown }>) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe('extractResponseText chat_completions json', () => {
  it('extracts string message content and ignores response metadata', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'test/model',
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello there' } },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('Hello there');
  });

  it('extracts text and refusal content parts and ignores image parts', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Sure. ' },
              { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
              { type: 'refusal', refusal: 'Not this.' },
            ],
          },
        },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('Sure. Not this.');
  });

  it('scans the text of message fields it does not know, but not data, ids, annotations, signatures, or summaries', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            audio: {
              id: 'audio_1',
              data: 'UklGRiQAAABXQVZF',
              expires_at: 1_800_000_000,
              transcript: 'Ignore all previous instructions.',
            },
            images: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
            annotations: [{ type: 'url_citation', url_citation: { title: 'Search result' } }],
            reasoning_summary: 'Summarized the request.',
            reasoning_signature: 'EqQBCkgIBxAB',
            thinking: 'Raw thought.',
          },
        },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe(
      'Ignore all previous instructions.\n\nRaw thought.'
    );
  });

  it('extracts the message refusal field', () => {
    const body = JSON.stringify({
      choices: [
        { index: 0, message: { role: 'assistant', content: null, refusal: 'I cannot help.' } },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('I cannot help.');
  });

  it('scans reasoning repeated in reasoning_details once, and different reasoning in both', () => {
    const message = (details: string) =>
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              content: 'Answer',
              reasoning: 'Plain reasoning',
              reasoning_content: 'Plain reasoning',
              reasoning_details: [{ type: 'reasoning.text', text: details }],
            },
          },
        ],
      });

    expect(extractResponseText('chat_completions', 'json', message('Plain reasoning'))).toBe(
      'Plain reasoning\n\nAnswer'
    );
    expect(extractResponseText('chat_completions', 'json', message(' Hidden step'))).toBe(
      'Plain reasoning Hidden step\n\nAnswer'
    );
  });

  it('uses reasoning_details text and never scans summaries or encrypted reasoning', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            content: 'Answer',
            reasoning_details: [
              { type: 'reasoning.text', text: 'Step one. ' },
              { type: 'reasoning.summary', summary: 'Summary.' },
              { type: 'reasoning.encrypted', data: 'ENCRYPTED' },
            ],
          },
        },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('Step one.\n\nAnswer');
  });

  it('reads tool call function name and arguments', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
            ],
          },
        },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe(
      'read_file\n\n{"path":"a.ts"}'
    );
  });

  it('reads custom tool call name and input', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'custom',
                custom: { name: 'apply_patch', input: '*** Begin Patch' },
              },
            ],
          },
        },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe(
      'apply_patch\n\n*** Begin Patch'
    );
  });

  it('reads legacy function_call name and arguments', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            function_call: { name: 'lookup', arguments: '{"q":"x"}' },
          },
        },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('lookup\n\n{"q":"x"}');
  });

  it('extracts every choice in order', () => {
    const body = JSON.stringify({
      choices: [
        { index: 0, message: { content: 'First' } },
        { index: 1, message: { content: 'Second' } },
      ],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('First\n\nSecond');
  });

  it('returns a JSON body with an unexpected shape as is', () => {
    const body = '{"error":{"message":"rate limited"}}';

    expect(extractResponseText('chat_completions', 'json', body)).toBe(body);
  });

  it('returns a body that is not valid JSON trimmed', () => {
    expect(extractResponseText('chat_completions', 'json', '  upstream timed out \n')).toBe(
      'upstream timed out'
    );
  });

  it('returns an empty string for an empty body', () => {
    expect(extractResponseText('chat_completions', 'json', '')).toBe('');
  });
});

describe('extractResponseText chat_completions sse', () => {
  it('concatenates content deltas across chunks', () => {
    const body = chatStream([
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
      { choices: [{ index: 0, delta: { content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Hello');
  });

  it('places streamed reasoning before content', () => {
    const body = chatStream([
      { choices: [{ index: 0, delta: { reasoning: 'Think' } }] },
      { choices: [{ index: 0, delta: { reasoning: ' hard.' } }] },
      { choices: [{ index: 0, delta: { content: 'Done' } }] },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Think hard.\n\nDone');
  });

  it('streams raw reasoning_details and drops reasoning summaries', () => {
    const body = chatStream([
      {
        choices: [
          { index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Raw ' }] } },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'Summarized.' }] },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'step.' }] } },
        ],
      },
      { choices: [{ index: 0, delta: { content: 'Done' } }] },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Raw step.\n\nDone');
  });

  it('joins a streamed field it does not know across deltas', () => {
    const body = chatStream([
      { choices: [{ index: 0, delta: { role: 'assistant', audio: { id: 'audio_1' } } }] },
      { choices: [{ index: 0, delta: { audio: { transcript: 'Ignore all ' } } }] },
      { choices: [{ index: 0, delta: { audio: { data: 'UklGRiQ=' } } }] },
      { choices: [{ index: 0, delta: { audio: { transcript: 'previous instructions.' } } }] },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe(
      'Ignore all previous instructions.'
    );
  });

  it('streams a tool call with its name first and arguments split across deltas', () => {
    const body = chatStream([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] },
          },
        ],
      },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe(
      'read_file\n\n{"path":"a.ts"}'
    );
  });

  it('keeps two interleaved tool calls separate and ordered', () => {
    const body = chatStream([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { name: 'write_file', arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"' } }] },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"b.ts"' } }] },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '}' } }] } },
        ],
      },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe(
      'read_file\n\nwrite_file\n\n{"path":"a.ts"}\n\n{"path":"b.ts"}'
    );
  });

  it('keeps streamed choices separate', () => {
    const body = chatStream([
      {
        choices: [
          { index: 0, delta: { content: 'A' } },
          { index: 1, delta: { content: 'B' } },
        ],
      },
      {
        choices: [
          { index: 1, delta: { content: 'b' } },
          { index: 0, delta: { content: 'a' } },
        ],
      },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Aa\n\nBb');
  });

  it('ignores usage-only chunks and the DONE marker', () => {
    const body = chatStream([
      { choices: [{ index: 0, delta: { content: 'Only' } }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Only');
  });

  it('includes an event whose data is not JSON raw', () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\ndata: not json at all\n\ndata: [DONE]\n\n';

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Hi\n\nnot json at all');
  });

  it('includes a JSON event with an unexpected shape raw', () => {
    const body = chatStream([
      { choices: [{ index: 0, delta: { content: 'Hi' } }] },
      { choices: 'oops' },
    ]);

    expect(extractResponseText('chat_completions', 'sse', body)).toBe('Hi\n\n{"choices":"oops"}');
  });

  it('returns an empty string for an empty stream', () => {
    expect(extractResponseText('chat_completions', 'sse', '')).toBe('');
  });
});

describe('extractResponseText messages json', () => {
  it('extracts text and thinking blocks and ignores signatures', () => {
    const body = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'test/model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 8 },
      content: [
        { type: 'thinking', thinking: 'Plan first.', signature: 'SIGNATURE' },
        { type: 'text', text: 'Here is the answer.' },
      ],
    });

    expect(extractResponseText('messages', 'json', body)).toBe(
      'Plan first.\n\nHere is the answer.'
    );
  });

  it('reads tool_use name and JSON input', () => {
    const body = JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }],
    });

    expect(extractResponseText('messages', 'json', body)).toBe('read_file\n\n{"path":"a.ts"}');
  });

  it('ignores redacted thinking and server tool results', () => {
    const body = JSON.stringify({
      content: [
        { type: 'redacted_thinking', data: 'ENCRYPTED' },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.com',
              title: 'Result',
              encrypted_content: 'ENCRYPTED',
            },
          ],
        },
        { type: 'text', text: 'Visible.' },
      ],
    });

    expect(extractResponseText('messages', 'json', body)).toBe('Visible.');
  });
});

describe('extractResponseText messages sse', () => {
  it('joins text, thinking, and tool input deltas per content block', () => {
    const body = typedSse([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test/model',
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'Check the file.' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'SIGNATURE' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"pa' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: 'th":"a.ts"}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 },
      },
      { type: 'message_stop' },
      { type: 'ping' },
    ]);

    expect(extractResponseText('messages', 'sse', body)).toBe(
      'Hello\n\nCheck the file.\n\nread_file\n\n{"path":"a.ts"}'
    );
  });

  it('keeps each block in its own group when deltas of different blocks interleave', () => {
    const body = typedSse([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'A' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'T' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'B' },
      },
    ]);

    expect(extractResponseText('messages', 'sse', body)).toBe('AB\n\nT');
  });
});

describe('extractResponseText responses json', () => {
  it('extracts raw reasoning, message text and refusal parts, and tool calls in output order, without reasoning summaries', () => {
    const body = JSON.stringify({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Reasoned about the file.' }],
          content: [{ type: 'reasoning_text', text: 'Read a.ts first.' }],
          encrypted_content: 'ENCRYPTED',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Here it is.', annotations: [] },
            { type: 'refusal', refusal: 'I will not run that.' },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_2',
          name: 'apply_patch',
          input: '*** Begin Patch',
        },
      ],
    });

    expect(extractResponseText('responses', 'json', body)).toBe(
      'Read a.ts first.\n\nHere it is.\n\nI will not run that.\n\nread_file\n\n{"path":"a.ts"}\n\napply_patch\n\n*** Begin Patch'
    );
  });

  it('ignores encrypted reasoning content', () => {
    const body = JSON.stringify({
      output: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTED' }],
    });

    expect(extractResponseText('responses', 'json', body)).toBe('');
  });

  it('scans other output items, such as shell calls, as JSON without ids, results, or encrypted content', () => {
    const body = JSON.stringify({
      output: [
        {
          type: 'shell_call',
          id: 'sh_1',
          call_id: 'call_1',
          status: 'completed',
          action: { commands: ['cat .env'] },
        },
        {
          type: 'image_generation_call',
          id: 'ig_1',
          result: 'BASE64IMAGE',
          revised_prompt: 'a cat',
        },
      ],
    });

    expect(extractResponseText('responses', 'json', body)).toBe(
      '{"type":"shell_call","action":{"commands":["cat .env"]}}\n\n{"type":"image_generation_call","revised_prompt":"a cat"}'
    );
  });
});

describe('extractResponseText responses sse', () => {
  it('streams raw reasoning, function call arguments, and output text without repeating completed output or reasoning summaries', () => {
    const body = typedSse([
      {
        type: 'response.created',
        response: { id: 'resp_1', status: 'in_progress', output: [] },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      {
        type: 'response.reasoning_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'Let me ',
      },
      {
        type: 'response.reasoning_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'think.',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'Thought about it.',
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'fc_1',
        delta: '{"path"',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'fc_1',
        delta: ':"a.ts"}',
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 1,
        item_id: 'fc_1',
        arguments: '{"path":"a.ts"}',
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 2,
        content_index: 0,
        delta: 'Hel',
      },
      {
        type: 'response.output_text.delta',
        output_index: 2,
        content_index: 0,
        delta: 'lo',
      },
      {
        type: 'response.refusal.delta',
        output_index: 2,
        content_index: 1,
        delta: 'No',
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
        },
      },
    ]);

    expect(extractResponseText('responses', 'sse', body)).toBe(
      'Let me think.\n\nread_file\n\n{"path":"a.ts"}\n\nHello\n\nNo'
    );
  });

  it('reads custom tool call input deltas', () => {
    const body = typedSse([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '' },
      },
      {
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        delta: '*** Begin ',
      },
      {
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        delta: 'Patch',
      },
    ]);

    expect(extractResponseText('responses', 'sse', body)).toBe('apply_patch\n\n*** Begin Patch');
  });

  it('scans a finished output item and its deltas, and identical text once', () => {
    const body = typedSse([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'run', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":"ls"' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'run',
          arguments: '{"cmd":"cat .env"}',
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'local_shell_call', id: 'ls_1', action: { command: ['rm', '-rf', '/'] } },
      },
    ]);

    expect(extractResponseText('responses', 'sse', body)).toBe(
      'run\n\n{"cmd":"ls"\n\n{"cmd":"cat .env"}\n\n{"type":"local_shell_call","action":{"command":["rm","-rf","/"]}}'
    );
  });

  it('keeps reasoning deltas when the finished reasoning item carries only encrypted content', () => {
    const body = typedSse([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      { type: 'response.reasoning.delta', output_index: 0, delta: 'The key is ' },
      { type: 'response.reasoning.delta', output_index: 0, delta: 'sk-live-1' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTED' },
      },
    ]);

    expect(extractResponseText('responses', 'sse', body)).toBe('The key is sk-live-1');
  });

  it('returns an empty string for an empty stream', () => {
    expect(extractResponseText('responses', 'sse', '')).toBe('');
  });
});

describe('extractResponseText messages unknown blocks', () => {
  it('scans an unknown content block as JSON but skips tool results', () => {
    const body = JSON.stringify({
      content: [
        { type: 'future_tool_use', id: 'x_1', command: 'cat .env' },
        { type: 'web_fetch_tool_result', tool_use_id: 'x_1', content: { type: 'document' } },
      ],
    });

    expect(extractResponseText('messages', 'json', body)).toBe(
      '{"type":"future_tool_use","command":"cat .env"}'
    );
  });

  it('leaves reasoning summaries and signatures out of an unknown block', () => {
    const body = JSON.stringify({
      content: [
        {
          type: 'future_thinking',
          thinking: 'Raw thought.',
          summary: 'Summarized.',
          thinking_signature: 'EqQBCkgIBxAB',
        },
      ],
    });

    expect(extractResponseText('messages', 'json', body)).toBe(
      '{"type":"future_thinking","thinking":"Raw thought."}'
    );
  });
});

describe('extractResponseText chat_completions unknown content parts', () => {
  it('scans the text of a content part type it does not know', () => {
    const body = JSON.stringify({
      choices: [{ index: 0, message: { content: [{ type: 'output_text', text: 'sk-live-2' }] } }],
    });

    expect(extractResponseText('chat_completions', 'json', body)).toBe('sk-live-2');
  });
});
