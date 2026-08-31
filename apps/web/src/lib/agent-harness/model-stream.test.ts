import { expect, it } from '@jest/globals';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { boundedBody, streamHarnessModel } from './model-stream';

const outputHeaders = {
  'content-type': 'Text/Event-Stream; charset=utf-8',
  'request-id': 'request-1',
  authorization: 'upstream-secret',
};
const sse = (body: BodyInit | null) => new Response(body, { headers: outputHeaders });
function invoke(
  upstream: Response,
  request = new AbortController(),
  deadline = new AbortController()
) {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, deadline.signal, abort.signal]);
  const response = streamHarnessModel(
    upstream,
    new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json' }),
    {
      signal,
      abort,
      failure: code => ({
        error: { code, message: 'Safe error', retryable: code === 429 || code >= 500 },
      }),
      errorStatus: (error, invalid) => {
        if (request.signal.aborted) return 499;
        if (error instanceof TRPCError) return getHTTPStatusCodeFromError(error);
        return error instanceof SyntaxError || error instanceof z.ZodError ? invalid : 503;
      },
    }
  );
  return { response, abort };
}

it.each(['', 'x-provider: private-field\nretry: private-retry\n\n'])(
  'streams multiline SDK text, reasoning, usage, and identifiers (prefix %j)',
  async prefix => {
    const chunk = {
      id: 'generation-1',
      model: 'paid/model',
      created: 1,
      choices: [
        {
          index: 0,
          delta: { content: 'Hello', reasoning_content: 'Thinking' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.002 },
    };
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = Promise.withResolvers<void>();
    const { response, abort } = invoke(
      sse(
        new ReadableStream({
          start(controller) {
            upstream = controller;
            const data = JSON.stringify(chunk, null, 2).replaceAll('\n', '\ndata: ');
            controller.enqueue(new TextEncoder().encode(`${prefix}data: ${data}\n\n`));
          },
          cancel: () => cancelled.resolve(),
        })
      )
    );
    const reply = await response;
    const raw = reply.clone().text();
    const provider = createOpenAICompatible({
      name: 'harness',
      baseURL: 'https://unused.example',
      fetch: async () => reply,
    });
    const result = streamText({
      model: provider('paid/model'),
      messages: [{ role: 'user', content: 'Hello' }],
      maxOutputTokens: 128,
      maxRetries: 0,
    });
    const reader = result.textStream.getReader();
    expect((await reader.read()).value).toBe('Hello');
    upstream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    expect((await reader.read()).done).toBe(true);
    expect((await result.response).id).toBe('generation-1');
    expect(await result.reasoningText).toBe('Thinking');
    expect(await result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(await result.finishReason).toBe('stop');
    expect(await raw).toBe(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    expect(reply.headers.get('authorization')).toBeNull();
    expect(reply.headers.get('request-id')).toBe('request-1');
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.headers.get('content-encoding')).toBe('identity');
    await cancelled.promise;
    expect(abort.signal.aborted).toBe(true);
  }
);
it('preserves split UTF-8, tool extensions, and separate usage events', async () => {
  const tool = {
    id: 'call-1',
    function: { name: 'lookup', arguments: '{}' },
    extra_content: { google: { thought_signature: 'signature-1' } },
  };
  const delta = {
    choices: [{ delta: { content: '界', reasoning: 'Thinking', tool_calls: [tool] } }],
  };
  const usage = {
    choices: [],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      cost: 0.002,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 1, accepted_prediction_tokens: 1 },
    },
  };
  const data = `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(data);
  const split = bytes.indexOf(0xe7) + 1;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split, split + 1));
      controller.enqueue(bytes.slice(split + 1));
      controller.close();
    },
  });
  expect(await (await invoke(sse(body)).response).text()).toBe(data);
});
it.each([400, 401, 402, 403, 429, 503])('sanitizes terminal stream error %s', async code => {
  const error = JSON.stringify({
    error: { code, message: 'upstream-secret', metadata: { authorization: 'credential' } },
  });
  const { response, abort } = invoke(sse(`data: ${error}\n\ndata: [DONE]\n\n`));
  const reply = await response;
  const text = await reply.text();
  expect(reply.status).toBe(200);
  expect(text).toContain(`"code":${code}`);
  expect(text).toContain(`"retryable":${code === 429 || code === 503}`);
  expect(text).not.toMatch(/upstream-secret|credential|\[DONE\]/);
  expect(abort.signal.aborted).toBe(true);
});
it.each([
  ['data: private-malformed\n\n', 422],
  [`data: ${'x'.repeat(1024 * 1024)}\n\n`, 413],
  ['data: []\n\n', 422],
  ['data: {"metadata":"private-malformed"}\n\n', 422],
  ['event: error\ndata: {"choices":[]}\n\n', 422],
  ['data: {"error":{"code":200,"message":"private-malformed"}}\n\n', 422],
] as const)('rejects malformed or oversized streams (case %#)', async (data, code) => {
  const text = await (await invoke(sse(data)).response).text();
  expect(text).toContain(`"code":${code}`);
  expect(text).not.toContain('private-malformed');
});
it.each([
  { choices: ['private-malformed'] },
  { choices: [{ delta: 'private-malformed' }] },
  { choices: [{ delta: { content: ['private-malformed'] } }] },
  { choices: [{ delta: { tool_calls: ['private-malformed'] } }] },
  { usage: 'private-malformed' },
  { usage: ['private-malformed'] },
  { usage: { prompt_tokens: 'private-malformed' } },
  { usage: { completion_tokens_details: { reasoning_tokens: 'private-malformed' } } },
])('sanitizes malformed SDK payloads before forwarding (case %#)', async payload => {
  const data = JSON.stringify({ choices: [], ...payload });
  const { response, abort } = invoke(sse(`data: ${data}\n\ndata: [DONE]\n\n`));
  const text = await (await response).text();
  expect(text).not.toContain('private-malformed');
  expect(text).toBe('data: {"error":{"code":422,"message":"Safe error","retryable":false}}\n\n');
  expect(abort.signal.aborted).toBe(true);
});
it.each([0, 1])('counts cumulative bytes before decoding (extra bytes: %s)', async extra => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024));
      controller.enqueue(new Uint8Array(512 * 1024 + extra));
      controller.close();
    },
  });
  const result = new Response(boundedBody(body, new AbortController().signal)).arrayBuffer();
  if (extra) await expect(result).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  else expect((await result).byteLength).toBe(1024 * 1024);
});
it.each(['', 'data: [DONE]\n\n'])('preserves empty output %j', async data => {
  const { response, abort } = invoke(sse(data));
  expect(await (await response).text()).toBe(data);
  expect(abort.signal.aborted).toBe(true);
});
it.each([
  new Response('upstream-secret', { status: 429 }),
  new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
  sse(null),
])('rejects HTTP failures, wrong media, and missing bodies (case %#)', async upstream => {
  const reply = await invoke(upstream).response;
  expect(reply.status).toBe(upstream.status === 429 ? 429 : 422);
  expect(await reply.text()).not.toMatch(/upstream-secret|private/);
});
it('sanitizes a failed upstream read', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('transport-secret'));
    },
  });
  const { response, abort } = invoke(sse(body));
  const text = await (await response).text();
  expect(text).toContain('"code":503');
  expect(text).not.toContain('transport-secret');
  expect(abort.signal.aborted).toBe(true);
});
it.each(['request', 'reader', 'deadline'])('cancels and cleans up through the %s', async target => {
  const cancelled = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({ cancel: () => cancelled.resolve() });
  const request = new AbortController();
  const deadline = new AbortController();
  const { response, abort } = invoke(sse(body), request, deadline);
  const reply = await response;
  if (target === 'reader') await reply.body!.cancel();
  else {
    const text = reply.text();
    (target === 'request' ? request : deadline).abort(new Error('private'));
    const output = await text;
    expect(output).toContain(`"code":${target === 'request' ? 499 : 503}`);
    expect(output).not.toContain('private');
  }
  await cancelled.promise;
  expect(abort.signal.aborted).toBe(true);
});
