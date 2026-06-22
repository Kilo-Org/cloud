import { describe, expect, it } from 'vitest';
import { fetchKiloGatewayChatCompletionStream } from './kilo-api-client';
import type { FetchLike } from './auth';

const parseJsonRequestBody = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') {
    throw new TypeError('Expected JSON string request body.');
  }

  return JSON.parse(body);
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
          code: 'return document.title;',
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
});
