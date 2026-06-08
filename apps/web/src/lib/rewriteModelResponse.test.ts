import { describe, test, expect } from '@jest/globals';
import {
  rewriteFreeModelResponse_ChatCompletions,
  rewriteFreeModelResponse_Messages,
  rewriteFreeModelResponse_Responses,
} from './rewriteModelResponse';

const REWRITTEN_MODEL = 'kilo/my-free-model';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function readOutputStream(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Returns the `data:` payloads from an SSE string, in order. */
function dataPayloads(sse: string): string[] {
  return sse
    .split('\n\n')
    .map(block =>
      block
        .split('\n')
        .find(line => line.startsWith('data: '))
        ?.slice('data: '.length)
    )
    .filter((payload): payload is string => payload !== undefined);
}

/** Parses every non-`[DONE]` SSE data payload as JSON. */
function dataObjects(sse: string): unknown[] {
  return dataPayloads(sse)
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload));
}

describe('rewriteFreeModelResponse_ChatCompletions', () => {
  describe('JSON responses', () => {
    test('rewrites the model and strips upstream cost fields', async () => {
      const upstream = jsonResponse({
        model: 'upstream-model',
        usage: {
          cost: 0.5,
          cost_details: { upstream_inference_cost: 0.4 },
          is_byok: true,
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      });

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);
      const json = await result.json();

      expect(json.model).toBe(REWRITTEN_MODEL);
      expect(json.usage.cost).toBeUndefined();
      expect(json.usage.cost_details).toBeUndefined();
      expect(json.usage.is_byok).toBeUndefined();
      expect(json.usage.prompt_tokens).toBe(10);
      expect(json.usage.prompt_tokens_details.cached_tokens).toBe(3);
      expect(result.headers.get('content-encoding')).toBe('identity');
    });

    test('defaults cached_tokens to 0 when absent', async () => {
      const upstream = jsonResponse({
        model: 'upstream-model',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: {},
        },
      });

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);
      const json = await result.json();

      expect(json.usage.prompt_tokens_details.cached_tokens).toBe(0);
    });

    test('passes through invalid JSON bodies unchanged and preserves status', async () => {
      const upstream = new Response('not-json{', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'application/json' },
      });

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);

      expect(result.status).toBe(502);
      expect(await result.text()).toBe('not-json{');
    });
  });

  describe('streaming responses', () => {
    test('rewrites model, drops null delta role, and emits [DONE]', async () => {
      const upstream = sseResponse(
        'data: {"model":"upstream-model","choices":[{"delta":{"role":null,"content":"hi"}}]}\n\n' +
          'data: [DONE]\n\n'
      );

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);
      const sse = await readOutputStream(result);
      const [chunk] = dataObjects(sse) as Array<{
        model: string;
        choices: Array<{ delta: { role?: unknown; content: string } }>;
      }>;

      expect(chunk.model).toBe(REWRITTEN_MODEL);
      expect('role' in chunk.choices[0].delta).toBe(false);
      expect(chunk.choices[0].delta.content).toBe('hi');
      expect(dataPayloads(sse)).toContain('[DONE]');
    });

    test('adds an empty choices array and strips cost on usage-only chunks', async () => {
      const upstream = sseResponse(
        'data: {"model":"upstream-model","usage":{"cost":1,"is_byok":true,"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{}}}\n\n'
      );

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);
      const sse = await readOutputStream(result);
      const [chunk] = dataObjects(sse) as Array<{
        model: string;
        choices: unknown[];
        usage: {
          cost?: number;
          is_byok?: boolean;
          prompt_tokens_details: { cached_tokens: number };
        };
      }>;

      expect(chunk.model).toBe(REWRITTEN_MODEL);
      expect(chunk.choices).toEqual([]);
      expect(chunk.usage.cost).toBeUndefined();
      expect(chunk.usage.is_byok).toBeUndefined();
      expect(chunk.usage.prompt_tokens_details.cached_tokens).toBe(0);
    });

    test('forwards SSE comments as a processing keep-alive', async () => {
      const upstream = sseResponse(
        ': openrouter heartbeat\n\n' + 'data: {"model":"upstream-model","choices":[]}\n\n'
      );

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);
      const sse = await readOutputStream(result);

      expect(sse).toContain(': KILO PROCESSING');
    });

    test('returns an empty body when upstream has no body', async () => {
      const upstream = new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await rewriteFreeModelResponse_ChatCompletions(upstream, REWRITTEN_MODEL);

      expect(await readOutputStream(result)).toBe('');
    });
  });
});

describe('rewriteFreeModelResponse_Messages', () => {
  test('rewrites model and strips cost fields for JSON responses', async () => {
    const upstream = jsonResponse({
      type: 'message',
      model: 'upstream-model',
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        cost: 0.3,
        cost_details: { upstream_inference_cost: 0.2 },
        is_byok: false,
      },
    });

    const result = await rewriteFreeModelResponse_Messages(upstream, REWRITTEN_MODEL);
    const json = await result.json();

    expect(json.model).toBe(REWRITTEN_MODEL);
    expect(json.usage.input_tokens).toBe(20);
    expect(json.usage.cost).toBeUndefined();
    expect(json.usage.cost_details).toBeUndefined();
    expect(json.usage.is_byok).toBeUndefined();
  });

  test('passes through invalid JSON bodies unchanged', async () => {
    const upstream = new Response('}{', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });

    const result = await rewriteFreeModelResponse_Messages(upstream, REWRITTEN_MODEL);

    expect(result.status).toBe(500);
    expect(await result.text()).toBe('}{');
  });

  test('rewrites message_start and message_delta usage and ignores [DONE]', async () => {
    const upstream = sseResponse(
      'data: {"type":"message_start","message":{"model":"upstream-model","usage":{"input_tokens":11,"output_tokens":0,"cost":0.1,"is_byok":true}}}\n\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":9,"cost":0.2,"is_byok":true},"delta":{}}\n\n' +
        'data: [DONE]\n\n'
    );

    const result = await rewriteFreeModelResponse_Messages(upstream, REWRITTEN_MODEL);
    const sse = await readOutputStream(result);
    const events = dataObjects(sse) as Array<{
      type: string;
      message?: {
        model: string;
        usage: { cost?: number; is_byok?: boolean; input_tokens: number };
      };
      usage?: { cost?: number; is_byok?: boolean; output_tokens: number };
    }>;

    expect(events[0].message?.model).toBe(REWRITTEN_MODEL);
    expect(events[0].message?.usage.cost).toBeUndefined();
    expect(events[0].message?.usage.is_byok).toBeUndefined();
    expect(events[0].message?.usage.input_tokens).toBe(11);

    expect(events[1].usage?.cost).toBeUndefined();
    expect(events[1].usage?.is_byok).toBeUndefined();
    expect(events[1].usage?.output_tokens).toBe(9);

    // The [DONE] sentinel is re-emitted when upstream sends it.
    expect(dataPayloads(sse)).toContain('[DONE]');
  });

  test('does not synthesize a [DONE] sentinel when upstream omits it', async () => {
    const upstream = sseResponse(
      'data: {"type":"message_delta","usage":{"output_tokens":9},"delta":{}}\n\n'
    );

    const result = await rewriteFreeModelResponse_Messages(upstream, REWRITTEN_MODEL);
    const sse = await readOutputStream(result);

    expect(dataPayloads(sse)).not.toContain('[DONE]');
  });
});

describe('rewriteFreeModelResponse_Responses', () => {
  test('rewrites model and strips cost fields for JSON responses', async () => {
    const upstream = jsonResponse({
      id: 'resp_1',
      model: 'upstream-model',
      usage: {
        cost: 0.9,
        is_byok: true,
        prompt_tokens: 30,
        completion_tokens: 12,
        total_tokens: 42,
        prompt_tokens_details: {},
      },
    });

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const json = await result.json();

    expect(json.model).toBe(REWRITTEN_MODEL);
    expect(json.usage.cost).toBeUndefined();
    expect(json.usage.is_byok).toBeUndefined();
    expect(json.usage.prompt_tokens_details.cached_tokens).toBe(0);
  });

  test('rewrites the nested response model and usage in stream events and emits [DONE]', async () => {
    const upstream = sseResponse(
      'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"model":"upstream-model","usage":{"cost":0.5,"is_byok":true,"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"prompt_tokens_details":{"cached_tokens":1}}}}\n\n' +
        'data: [DONE]\n\n'
    );

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const sse = await readOutputStream(result);
    const [event] = dataObjects(sse) as Array<{
      type: string;
      response: {
        model: string;
        usage: {
          cost?: number;
          is_byok?: boolean;
          prompt_tokens_details: { cached_tokens: number };
        };
      };
    }>;

    expect(event.response.model).toBe(REWRITTEN_MODEL);
    expect(event.response.usage.cost).toBeUndefined();
    expect(event.response.usage.is_byok).toBeUndefined();
    expect(event.response.usage.prompt_tokens_details.cached_tokens).toBe(1);
    expect(sse).toContain('event: response.completed');
    expect(dataPayloads(sse)).toContain('[DONE]');
  });

  test('emits byte chunks that can be consumed through the Response body API', async () => {
    const upstream = sseResponse(
      'event: response.completed\n' +
        'data: {"type":"response.completed","sequence_number":0,"response":{"model":"upstream-model","status":"completed"}}\n\n'
    );

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const output = await result.text();

    expect(dataObjects(output)).toEqual([
      {
        type: 'response.completed',
        sequence_number: 0,
        response: { model: REWRITTEN_MODEL, status: 'completed' },
      },
    ]);
    expect(result.headers.get('cache-control')).toBe('no-cache, no-transform');
  });

  test('stops parsing a multi-event chunk when downstream backpressure applies', async () => {
    const upstream = sseResponse(
      'event: response.in_progress\n' +
        'data: {"type":"response.in_progress","sequence_number":0}\n\n' +
        'event: response.completed\n' +
        'data: not-json\n\n'
    );

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const reader = result.body?.getReader();
    if (!reader) throw new Error('Expected a response body');

    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);
    expect(dataObjects(new TextDecoder().decode(firstRead.value))).toEqual([
      { type: 'response.in_progress', sequence_number: 0 },
    ]);
    await expect(reader.read()).rejects.toBeInstanceOf(SyntaxError);
  });

  test('preserves contiguous events across one-byte chunks and split UTF-8 code points', async () => {
    const events = Array.from({ length: 58 }, (_, sequenceNumber) => {
      const type = sequenceNumber === 57 ? 'response.completed' : 'response.output_text.delta';
      const response =
        sequenceNumber === 57 ? `,"response":{"model":"upstream-model","status":"completed"}` : '';
      return `event: ${type}\ndata: {"type":"${type}","sequence_number":${sequenceNumber},"delta":"café"${response}}\n\n`;
    }).join('');
    const bytes = new TextEncoder().encode(events);
    let chunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunkIndex === bytes.length) {
          controller.close();
          return;
        }
        if (chunkIndex === 7 || chunkIndex === Math.floor(bytes.length / 2)) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        controller.enqueue(bytes.slice(chunkIndex, chunkIndex + 1));
        chunkIndex++;
      },
    });
    const upstream = new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const output = await result.text();
    const parsed = dataObjects(output) as Array<{
      type: string;
      sequence_number: number;
      delta: string;
      response?: { model: string; status: string };
    }>;

    expect(parsed).toHaveLength(58);
    expect(parsed.map(event => event.sequence_number)).toEqual(
      Array.from({ length: 58 }, (_, index) => index)
    );
    expect(parsed.every(event => event.delta === 'café')).toBe(true);
    expect(parsed.at(-1)).toMatchObject({
      type: 'response.completed',
      sequence_number: 57,
      response: { model: REWRITTEN_MODEL, status: 'completed' },
    });
  });

  test('forwards an empty reasoning item and a complete response without [DONE]', async () => {
    const upstream = sseResponse(
      'event: response.output_item.done\n' +
        'data: {"type":"response.output_item.done","sequence_number":0,"item":{"type":"reasoning","summary":[],"encrypted_content":"encrypted"}}\n\n' +
        'event: response.completed\n' +
        'data: {"type":"response.completed","sequence_number":1,"response":{"model":"upstream-model","status":"completed"}}\n\n'
    );

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const output = await result.text();
    const events = dataObjects(output) as Array<{
      type: string;
      item?: { type: string; summary: unknown[]; encrypted_content: string };
    }>;

    expect(events[0]).toMatchObject({
      type: 'response.output_item.done',
      item: { type: 'reasoning', summary: [], encrypted_content: 'encrypted' },
    });
    expect(events[1]).toMatchObject({ type: 'response.completed' });
    expect(dataPayloads(output)).not.toContain('[DONE]');
  });

  test('propagates a source error instead of converting it to clean EOF', async () => {
    const sourceError = new Error('source failed before response.completed');
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount++ === 0) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":0}\n\n'
            )
          );
          return;
        }
        controller.error(sourceError);
      },
    });
    const upstream = new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);

    await expect(result.text()).rejects.toBe(sourceError);
  });

  test('propagates downstream cancellation to the upstream reader', async () => {
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":0}\n\n'
          )
        );
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const upstream = new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });
    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const reader = result.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();

    const reason = new Error('downstream stopped');
    await reader?.cancel(reason);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cancelReason).toBe(reason);
  });

  test('dispatches a complete final event without a trailing blank delimiter', async () => {
    const upstream = sseResponse(
      'event: response.completed\n' +
        'data: {"type":"response.completed","sequence_number":0,"response":{"model":"upstream-model","status":"completed"}}'
    );

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const output = await result.text();

    expect(dataObjects(output)).toEqual([
      {
        type: 'response.completed',
        sequence_number: 0,
        response: { model: REWRITTEN_MODEL, status: 'completed' },
      },
    ]);
  });

  test('preserves SSE event IDs while normalizing comments and multiline data', async () => {
    const upstream = sseResponse(
      ': upstream heartbeat\n\n' +
        'unknown: ignored\n' +
        'id: event-57\n' +
        'event: response.completed\n' +
        'data: {"type":\n' +
        'data: "response.completed","response":{"model":"upstream-model","status":"completed"}}\n\n'
    );

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const output = await result.text();

    expect(output).toContain(': KILO PROCESSING\n\n');
    expect(output).toContain('id: event-57\n');
    expect(output).toContain('event: response.completed\n');
    expect(dataObjects(output)).toEqual([
      {
        type: 'response.completed',
        response: { model: REWRITTEN_MODEL, status: 'completed' },
      },
    ]);
  });

  test('delivers the same complete response while concurrent clones are drained', async () => {
    const body =
      'event: response.created\n' +
      'data: {"type":"response.created","sequence_number":0,"response":{"model":"upstream-model","status":"in_progress"}}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","sequence_number":1,"response":{"model":"upstream-model","status":"completed"}}\n\n';
    const upstream = sseResponse(body);
    const usageClone = upstream.clone();
    const loggingClone = upstream.clone();

    const result = await rewriteFreeModelResponse_Responses(upstream, REWRITTEN_MODEL);
    const [callerOutput, usageOutput, loggingOutput] = await Promise.all([
      result.text(),
      usageClone.text(),
      loggingClone.text(),
    ]);

    expect(
      (dataObjects(callerOutput) as Array<{ sequence_number: number }>).map(
        event => event.sequence_number
      )
    ).toEqual([0, 1]);
    expect(usageOutput).toBe(body);
    expect(loggingOutput).toBe(body);
  });
});
