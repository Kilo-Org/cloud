/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fetchKiloGatewayChatCompletionStream } from './kilo-api-client';
import type { FetchLike } from './auth';

const jsonRequestBodySchema = z.record(z.string(), z.unknown());

const parseJsonRequestBody = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') {
    throw new TypeError('Expected JSON string request body.');
  }

  return jsonRequestBodySchema.parse(JSON.parse(body));
};

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

describe('kilo gateway chat stream client', () => {
  it('streams chat completion content and eval tool call deltas', async () => {
    const seen: { body: unknown; headers: Headers }[] = [];
    const contentDeltas: string[] = [];
    const fetch: FetchLike = (_input, init) => {
      seen.push({
        body: parseJsonRequestBody(init?.body),
        headers: new Headers(init?.headers),
      });

      return streamResponse([
        'data: {"choices":[{"delta":{"content":"I will "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"inspect."}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_eval_1","type":"function","function":{"name":"eval","arguments":"{\\"code\\":\\"return "}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"document.title;\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Inspect this page', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        onContentDelta: delta => {
          contentDeltas.push(delta);
        },
        organizationId: 'org-1',
        token: 'token-1',
        tools: [
          {
            function: {
              description: 'Run JavaScript',
              name: 'eval',
              parameters: { additionalProperties: false, type: 'object' },
            },
            type: 'function',
          },
        ],
      })
    ).resolves.toStrictEqual({
      content: 'I will inspect.',
      toolCalls: [
        {
          arguments: { code: 'return document.title;' },
          id: 'call_eval_1',
          name: 'eval',
        },
      ],
    });
    expect(contentDeltas).toStrictEqual(['I will ', 'inspect.']);
    expect(seen[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(seen[0]?.headers.get('x-kilocode-organizationid')).toBe('org-1');
    expect(seen[0]?.body).toMatchObject({ stream: true });
  });

  it('streams safe read tool call deltas', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot_1","type":"function","function":{"name":"get_page_snapshot","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Read this page', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        onContentDelta: () => {},
        token: 'token-1',
        tools: [],
      })
    ).resolves.toStrictEqual({
      toolCalls: [
        {
          arguments: {},
          id: 'call_snapshot_1',
          name: 'get_page_snapshot',
        },
      ],
    });
  });

  it('streams viewport screenshot tool call deltas', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_screenshot_1","type":"function","function":{"name":"get_viewport_screenshot","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Look at this page', role: 'user' }],
        model: 'kilo-auto/frontier',
        onContentDelta: () => {},
        token: 'token-1',
        tools: [],
      })
    ).resolves.toStrictEqual({
      toolCalls: [
        {
          arguments: {},
          id: 'call_screenshot_1',
          name: 'get_viewport_screenshot',
        },
      ],
    });
  });

  it('streams tool call deltas when the gateway sends null content', async () => {
    const contentDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"","reasoning":"Thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Calling the tool."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":null,"reasoning":null,"tool_calls":[{"index":0,"id":"call_snapshot_1","type":"function","function":{"name":"get_page_snapshot","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Read this page', role: 'user' }],
        model: 'kilo-auto/frontier',
        onContentDelta: delta => {
          contentDeltas.push(delta);
        },
        onReasoningDelta: delta => {
          reasoningDeltas.push(delta);
        },
        token: 'token-1',
        tools: [],
      })
    ).resolves.toStrictEqual({
      content: 'Calling the tool.',
      reasoning: 'Thinking',
      toolCalls: [
        {
          arguments: {},
          id: 'call_snapshot_1',
          name: 'get_page_snapshot',
        },
      ],
    });
    expect(contentDeltas).toStrictEqual(['Calling the tool.']);
    expect(reasoningDeltas).toStrictEqual(['Thinking']);
  });

  it('rejects non-object tool call arguments from the gateway stream', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot_1","type":"function","function":{"name":"get_page_snapshot","arguments":"[]"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Read this page', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        onContentDelta: () => {},
        token: 'token-1',
        tools: [],
      })
    ).rejects.toThrow('Gateway tool call arguments were not an object.');
  });

  it('ignores empty content deltas before visible content', async () => {
    const contentDeltas: string[] = [];
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Visible answer."}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Inspect this page', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        onContentDelta: delta => {
          contentDeltas.push(delta);
        },
        token: 'token-1',
        tools: [],
      })
    ).resolves.toStrictEqual({
      content: 'Visible answer.',
      toolCalls: [],
    });

    expect(contentDeltas).toStrictEqual(['Visible answer.']);
  });

  it('streams reasoning deltas separately from visible content', async () => {
    const contentDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"","reasoning":"Think","reasoning_details":[{"type":"reasoning.text","text":"Think","format":"unknown","index":0}]}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"","reasoning":"ing"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Visible answer."}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Think', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        onContentDelta: delta => {
          contentDeltas.push(delta);
        },
        onReasoningDelta: delta => {
          reasoningDeltas.push(delta);
        },
        token: 'token-1',
        tools: [],
      })
    ).resolves.toStrictEqual({
      content: 'Visible answer.',
      reasoning: 'Thinking',
      reasoningDetails: [{ format: 'unknown', index: 0, text: 'Think', type: 'reasoning.text' }],
      toolCalls: [],
    });

    expect(contentDeltas).toStrictEqual(['Visible answer.']);
    expect(reasoningDeltas).toStrictEqual(['Think', 'ing']);
  });

  it('accumulates reasoning detail text across deltas and keeps the final signature', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"reasoning":"Th","reasoning_details":[{"type":"reasoning.text","text":"Th","index":0}]}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"ink","reasoning_details":[{"type":"reasoning.text","text":"ink","signature":"sig-1","index":0}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    const completion = await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Think', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      onContentDelta: () => {},
      token: 'token-1',
      tools: [],
    });

    expect(completion.reasoningDetails).toStrictEqual([
      { index: 0, signature: 'sig-1', text: 'Think', type: 'reasoning.text' },
    ]);
  });

  it('parses CRLF-separated SSE records split across chunk boundaries', async () => {
    const contentDeltas: string[] = [];
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r',
        '\ndata: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ]);

    const completion = await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Hi', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      onContentDelta: delta => contentDeltas.push(delta),
      token: 'token-1',
      tools: [],
    });

    expect(contentDeltas.join('')).toBe('Hello');
    expect(completion).toMatchObject({ content: 'Hello' });
  });

  it('sends selected thinking effort as gateway reasoning', async () => {
    let seenBody: unknown = null;
    const fetch: FetchLike = (_input, init) => {
      seenBody = parseJsonRequestBody(init?.body);

      return streamResponse(['data: [DONE]\n\n']);
    };

    await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Think hard', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      onContentDelta: () => {},
      thinkingEffort: 'high',
      token: 'token-1',
      tools: [],
    });

    expect(seenBody).toMatchObject({
      reasoning: { effort: 'high', enabled: true },
    });
  });

  it('disables gateway reasoning for none thinking effort', async () => {
    let seenBody: unknown = null;
    const fetch: FetchLike = (_input, init) => {
      seenBody = parseJsonRequestBody(init?.body);

      return streamResponse(['data: [DONE]\n\n']);
    };

    await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Be fast', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      onContentDelta: () => {},
      thinkingEffort: 'none',
      token: 'token-1',
      tools: [],
    });

    expect(seenBody).toMatchObject({
      reasoning: { effort: 'none', enabled: false },
    });
  });

  it('maps instant thinking effort to disabled gateway reasoning', async () => {
    let seenBody: unknown = null;
    const fetch: FetchLike = (_input, init) => {
      seenBody = parseJsonRequestBody(init?.body);

      return streamResponse(['data: [DONE]\n\n']);
    };

    await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Be instant', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      onContentDelta: () => {},
      thinkingEffort: 'instant',
      token: 'token-1',
      tools: [],
    });

    expect(seenBody).toMatchObject({
      reasoning: { effort: 'none', enabled: false },
    });
  });

  it('sends xhigh thinking effort as gateway reasoning', async () => {
    let seenBody: unknown = null;
    const fetch: FetchLike = (_input, init) => {
      seenBody = parseJsonRequestBody(init?.body);

      return streamResponse(['data: [DONE]\n\n']);
    };

    await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Think harder', role: 'user' }],
      model: 'anthropic/claude-opus-4',
      onContentDelta: () => {},
      thinkingEffort: 'xhigh',
      token: 'token-1',
      tools: [],
    });

    expect(seenBody).toMatchObject({ reasoning: { effort: 'xhigh', enabled: true } });
    expect(seenBody).not.toHaveProperty('verbosity');
  });

  it('maps max thinking effort to xhigh reasoning with max verbosity', async () => {
    let seenBody: unknown = null;
    const fetch: FetchLike = (_input, init) => {
      seenBody = parseJsonRequestBody(init?.body);

      return streamResponse(['data: [DONE]\n\n']);
    };

    await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Think hardest', role: 'user' }],
      model: 'anthropic/claude-opus-4',
      onContentDelta: () => {},
      thinkingEffort: 'max',
      token: 'token-1',
      tools: [],
    });

    expect(seenBody).toMatchObject({
      reasoning: { effort: 'xhigh', enabled: true },
      verbosity: 'max',
    });
  });

  it('omits reasoning for unrecognized thinking effort variants', async () => {
    let seenBody: unknown = null;
    const fetch: FetchLike = (_input, init) => {
      seenBody = parseJsonRequestBody(init?.body);

      return streamResponse(['data: [DONE]\n\n']);
    };

    await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://app.kilo.ai',
      fetch,
      messages: [{ content: 'Think weird', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      onContentDelta: () => {},
      thinkingEffort: 'bogus',
      token: 'token-1',
      tools: [],
    });

    expect(seenBody).not.toHaveProperty('reasoning');
  });
});
