/* eslint-disable max-lines, no-promise-executor-return, promise/avoid-new, promise/always-return, promise/prefer-await-to-then, jest/no-conditional-in-test, unicorn/consistent-function-scoping -- Stream fixtures need raw promises and conditional fakes. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  fetchKiloGatewayChatCompletionStream,
  KiloGatewayHttpError,
  KiloGatewayStreamStalledError,
  parseKiloGatewayChatCompletionStream,
} from './kilo-api-client';
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

  it('streams remote MCP tool call deltas', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mcp_1","type":"function","function":{"name":"mcp_fixture-mcp_get_weather","arguments":"{\\"city\\":\\"Skopje\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'What is the weather?', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        onContentDelta: () => {},
        token: 'token-1',
        tools: [],
      })
    ).resolves.toStrictEqual({
      toolCalls: [
        {
          arguments: { city: 'Skopje' },
          id: 'call_mcp_1',
          name: 'mcp_fixture-mcp_get_weather',
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

  it('treats a single empty-arguments tool call delta as an empty object', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot_1","type":"function","function":{"name":"get_page_snapshot","arguments":""}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Read this page', role: 'user' }],
        model: 'kilo-auto/frontier',
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

  it('treats tool call deltas that omit arguments as an empty object', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot_1","type":"function","function":{"name":"get_page_snapshot"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch,
        messages: [{ content: 'Read this page', role: 'user' }],
        model: 'kilo-auto/frontier',
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

  it('rejects non-empty invalid tool call arguments from the gateway stream', async () => {
    const fetch: FetchLike = () =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_snapshot_1","type":"function","function":{"name":"get_page_snapshot","arguments":"not-json"}}]}}]}\n\n',
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
    ).rejects.toThrow('Gateway tool call arguments were not valid JSON.');
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

  it('extracts usage from the trailing usage chunk', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,"total_tokens":1234}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const completion = parseKiloGatewayChatCompletionStream(sse, () => {});

    expect(completion.usage).toStrictEqual({
      promptTokens: 1200,
    });
  });

  it('carries costUsd when the usage chunk includes cost', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,"total_tokens":1234,"cost":0.0123}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const completion = parseKiloGatewayChatCompletionStream(sse, () => {});

    expect(completion.usage).toStrictEqual({
      costUsd: 0.0123,
      promptTokens: 1200,
    });
  });

  it('omits costUsd when the usage chunk has no cost field', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":10,"total_tokens":810}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const completion = parseKiloGatewayChatCompletionStream(sse, () => {});

    expect(completion.usage).toStrictEqual({
      promptTokens: 800,
    });
    expect(completion.usage).not.toHaveProperty('costUsd');
  });

  it('parses prompt_tokens when cost is null and omits costUsd', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":2,"total_tokens":502,"cost":null}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const completion = parseKiloGatewayChatCompletionStream(sse, () => {});

    expect(completion.usage).toStrictEqual({
      promptTokens: 500,
    });
    expect(completion.usage).not.toHaveProperty('costUsd');
  });
});

describe('stall watchdog', () => {
  it('throws KiloGatewayStreamStalledError when no bytes arrive for the stall timeout', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Never enqueue, never close: a stalled stream.
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
        )
      );

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://gateway.test',
        fetch,
        messages: [],
        model: 'test-model',
        onContentDelta: () => {},
        stallTimeoutMs: 50,
        token: 'token',
        tools: [],
      })
    ).rejects.toBeInstanceOf(KiloGatewayStreamStalledError);
  });

  it('completes when chunks keep arriving within the stall timeout', async () => {
    const encoder = new TextEncoder();
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
              );
              await new Promise(resolve => setTimeout(resolve, 40));
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n')
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
        )
      );

    const completion = await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://gateway.test',
      fetch,
      messages: [],
      model: 'test-model',
      onContentDelta: () => {},
      stallTimeoutMs: 100,
      token: 'token',
      tools: [],
    });

    expect(completion.content).toBe('ab');
  });

  it('throws a typed KiloGatewayHttpError carrying the status', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response('', { status: 503 }));

    const failure = await fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://gateway.test',
      fetch,
      messages: [],
      model: 'test-model',
      onContentDelta: () => {},
      token: 'token',
      tools: [],
    }).then(
      () => {},
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(KiloGatewayHttpError);
    expect(failure instanceof KiloGatewayHttpError ? failure.status : null).toBe(503);
  });

  it('reports a caller abort as an abort, not a stall', async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });

    const pending = fetchKiloGatewayChatCompletionStream({
      apiBaseUrl: 'https://gateway.test',
      fetch,
      messages: [],
      model: 'test-model',
      onContentDelta: () => {},
      signal: controller.signal,
      stallTimeoutMs: 10_000,
      token: 'token',
      tools: [],
    });
    controller.abort();

    const failure = await pending.then(
      () => {},
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof KiloGatewayStreamStalledError).toBe(false);
  });
});

describe('completion total cap', () => {
  it('cuts off a stream that keeps trickling past the completion timeout', async () => {
    const encoder = new TextEncoder();
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              // Trickle forever: never [DONE], never quiet long enough to stall.
              for (let index = 0; index < 1000; index += 1) {
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
                );
                // eslint-disable-next-line no-await-in-loop -- The fixture must pace its trickle.
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }
        )
      );

    await expect(
      fetchKiloGatewayChatCompletionStream({
        apiBaseUrl: 'https://gateway.test',
        completionTimeoutMs: 150,
        fetch,
        messages: [],
        model: 'test-model',
        onContentDelta: () => {},
        stallTimeoutMs: 5000,
        token: 'token',
        tools: [],
      })
    ).rejects.toThrow('exceeded 150 ms');
  });
});
