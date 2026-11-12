import { describe, expect, it } from '@jest/globals';
import { peekUpstreamStreamForContent } from './upstream-stream-peek';

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
}

function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

const DONE = 'data: [DONE]\n\n';

const idOnly = chunk({ choices: [], id: 'gen-1', object: 'chat.completion.chunk' });
const roleDelta = chunk({
  choices: [{ delta: { role: 'assistant' }, index: 0 }],
  id: 'gen-1',
  object: 'chat.completion.chunk',
});
const contentDelta = chunk({
  choices: [{ delta: { content: 'hello' }, index: 0 }],
  id: 'gen-1',
  object: 'chat.completion.chunk',
});

describe('peekUpstreamStreamForContent', () => {
  it('reports an envelope-only stream as empty and replays its bytes', async () => {
    const peeked = await peekUpstreamStreamForContent(sseResponse([idOnly, DONE]));

    expect(peeked.outcome).toBe('empty');
    expect(peeked.events).toBe(1);
    expect(peeked.generationId).toBe('gen-1');
    expect(await readAll(peeked.response)).toBe(idOnly + DONE);
  });

  it('reports a role chunk followed by a content delta as content', async () => {
    const text = roleDelta + contentDelta + DONE;
    const peeked = await peekUpstreamStreamForContent(sseResponse([roleDelta, contentDelta, DONE]));

    expect(peeked.outcome).toBe('content');
    expect(await readAll(peeked.response)).toBe(text);
  });

  it('replays a single-chunk stream byte for byte', async () => {
    const text = roleDelta + contentDelta + DONE;
    const peeked = await peekUpstreamStreamForContent(sseResponse([text]));

    expect(peeked.outcome).toBe('content');
    expect(await readAll(peeked.response)).toBe(text);
  });

  it('treats a reasoning-only stream as content', async () => {
    const reasoning = chunk({
      choices: [{ delta: { reasoning_content: 'thinking' }, index: 0 }],
      id: 'gen-2',
    });
    const peeked = await peekUpstreamStreamForContent(sseResponse([idOnly, reasoning, DONE]));

    expect(peeked.outcome).toBe('content');
  });

  it('treats a tool call delta as content', async () => {
    const toolCall = chunk({
      choices: [{ delta: { tool_calls: [{ function: { name: 'read' }, index: 0 }] }, index: 0 }],
      id: 'gen-3',
    });
    const peeked = await peekUpstreamStreamForContent(sseResponse([toolCall, DONE]));

    expect(peeked.outcome).toBe('content');
  });

  it('treats a refusal delta as content', async () => {
    const refusal = chunk({ choices: [{ delta: { refusal: 'no' }, index: 0 }] });
    const peeked = await peekUpstreamStreamForContent(sseResponse([refusal, DONE]));

    expect(peeked.outcome).toBe('content');
  });

  it('treats a delta field it does not model as content', async () => {
    const audio = chunk({ choices: [{ delta: { audio: { data: 'abc' } }, index: 0 }] });
    const peeked = await peekUpstreamStreamForContent(sseResponse([audio, DONE]));

    expect(peeked.outcome).toBe('content');
  });

  it('reports an empty delta object after the role chunk as empty', async () => {
    const emptyDelta = chunk({ choices: [{ delta: { content: '' }, index: 0 }] });
    const peeked = await peekUpstreamStreamForContent(sseResponse([roleDelta, emptyDelta, DONE]));

    expect(peeked.outcome).toBe('empty');
  });

  it('reports an empty chunk with no choices and no DONE as empty', async () => {
    const peeked = await peekUpstreamStreamForContent(sseResponse([idOnly]));

    expect(peeked.outcome).toBe('empty');
  });

  it('reports a chunk it cannot parse as unknown and preserves every byte', async () => {
    const text = 'data: not-json\n\n' + DONE;
    const peeked = await peekUpstreamStreamForContent(sseResponse([text]));

    expect(peeked.outcome).toBe('unknown');
    expect(await readAll(peeked.response)).toBe(text);
  });

  it('stops at the event cap, reporting unknown with every byte preserved', async () => {
    const text = idOnly + idOnly + contentDelta + DONE;
    const peeked = await peekUpstreamStreamForContent(
      sseResponse([idOnly, idOnly, contentDelta, DONE]),
      {
        maxEvents: 1,
      }
    );

    expect(peeked.outcome).toBe('unknown');
    expect(await readAll(peeked.response)).toBe(text);
  });

  it('stops at the time cap before reading, reporting unknown', async () => {
    const text = idOnly + DONE;
    const peeked = await peekUpstreamStreamForContent(sseResponse([text]), { maxMs: 0 });

    expect(peeked.outcome).toBe('unknown');
    expect(await readAll(peeked.response)).toBe(text);
  });

  it('forwards at the deadline when a stream stalls before content', async () => {
    const encoder = new TextEncoder();
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode(roleDelta));
      },
    });
    const peeked = await peekUpstreamStreamForContent(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      { maxMs: 20 }
    );

    expect(peeked.outcome).toBe('unknown');

    const reader = peeked.response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(roleDelta);
    // The read the peek left pending is the one the replay continues, so nothing is read twice.
    upstream!.enqueue(encoder.encode(contentDelta + DONE));
    upstream!.close();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toBe(contentDelta + DONE);
  });

  it('repeats a read failure to the replayed stream', async () => {
    const text = idOnly;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
      },
      pull() {
        throw new Error('upstream reset');
      },
    });
    const peeked = await peekUpstreamStreamForContent(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    );

    expect(peeked.outcome).toBe('unknown');
    const reader = peeked.response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          received += decoder.decode(value);
        }
      })()
    ).rejects.toThrow('upstream reset');
    expect(received).toBe(text);
  });

  it('leaves a response without a body unchanged', async () => {
    const response = new Response(null, { headers: { 'content-type': 'text/event-stream' } });
    const peeked = await peekUpstreamStreamForContent(response);

    expect(peeked.outcome).toBe('unknown');
    expect(peeked.response).toBe(response);
  });

  it('leaves a non-SSE response unchanged', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
    const peeked = await peekUpstreamStreamForContent(response);

    expect(peeked.outcome).toBe('unknown');
    expect(peeked.response).toBe(response);
  });

  it('leaves an unsuccessful response unchanged', async () => {
    const response = new Response('nope', {
      headers: { 'content-type': 'text/event-stream' },
      status: 500,
    });
    const peeked = await peekUpstreamStreamForContent(response);
    expect(peeked.outcome).toBe('unknown');
    expect(peeked.response).toBe(response);
  });

  it('records the provider the stream names', async () => {
    const named = chunk({ choices: [], id: 'gen-4', provider: 'Novita' });
    const peeked = await peekUpstreamStreamForContent(sseResponse([named, DONE]));

    expect(peeked.outcome).toBe('empty');
    expect(peeked.provider).toBe('Novita');
  });

  it('leaves a stream carrying an error frame as unknown', async () => {
    const failure = chunk({ error: { code: 429, message: 'slow down' }, id: 'gen-5' });
    const text = failure + DONE;
    const peeked = await peekUpstreamStreamForContent(sseResponse([text]));

    expect(peeked.outcome).toBe('unknown');
    expect(await readAll(peeked.response)).toBe(text);
  });
});
