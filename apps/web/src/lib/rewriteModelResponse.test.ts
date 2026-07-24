import { describe, test, expect } from '@jest/globals';
import {
  rewriteModelResponse_ChatCompletions,
  rewriteModelResponse_Messages,
  rewriteModelResponse_Responses,
} from './rewriteModelResponse';

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

function failingResponse(contentType: string, errorName: string, initialBody?: string): Response {
  const encoder = new TextEncoder();
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pullCount++ === 0 && initialBody !== undefined) {
        controller.enqueue(encoder.encode(initialBody));
        return;
      }

      const error = new Error(errorName);
      error.name = errorName;
      controller.error(error);
    },
  });

  return new Response(body, { headers: { 'content-type': contentType } });
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

const rewriters = [
  ['Chat Completions', rewriteModelResponse_ChatCompletions],
  ['Messages', rewriteModelResponse_Messages],
  ['Responses', rewriteModelResponse_Responses],
] as const;

describe.each(rewriters)('%s response read errors', (_name, rewrite) => {
  test.each([
    ['ResponseAborted', 'upstream_disconnect', 'disconnected'],
    ['TimeoutError', 'timeout', 'timed out'],
  ])('returns structured JSON for %s', async (errorName, errorType, messageFragment) => {
    const result = await rewrite(failingResponse('application/json', errorName));

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: expect.stringContaining(messageFragment),
      error_type: errorType,
      message: expect.stringContaining(messageFragment),
    });
  });
});

describe('rewriteModelResponse_ChatCompletions', () => {
  describe('JSON responses', () => {
    test('strips upstream cost fields', async () => {
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

      const result = await rewriteModelResponse_ChatCompletions(upstream);
      const json = await result.json();

      expect(json.model).toBe('upstream-model');
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

      const result = await rewriteModelResponse_ChatCompletions(upstream);
      const json = await result.json();

      expect(json.usage.prompt_tokens_details.cached_tokens).toBe(0);
    });

    test('passes through invalid JSON bodies unchanged and preserves status', async () => {
      const upstream = new Response('not-json{', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'application/json' },
      });

      const result = await rewriteModelResponse_ChatCompletions(upstream);

      expect(result.status).toBe(502);
      expect(await result.text()).toBe('not-json{');
    });
  });

  describe('streaming responses', () => {
    test.each([
      ['ResponseAborted', 'upstream_disconnect'],
      ['TimeoutError', 'timeout'],
    ])('emits a structured SSE error for %s', async (errorName, errorType) => {
      const upstream = failingResponse(
        'text/event-stream',
        errorName,
        'data: {"model":"upstream-model","choices":[]}\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream);
      const sse = await readOutputStream(result);
      const events = dataObjects(sse) as Array<{ error?: { code: number; type: string } }>;

      expect(events[0]).toMatchObject({ model: 'upstream-model' });
      expect(events[1]?.error).toMatchObject({ code: 503, type: errorType });
      expect(dataPayloads(sse)).not.toContain('[DONE]');
    });

    test('drops null delta role and emits [DONE]', async () => {
      const upstream = sseResponse(
        'data: {"model":"upstream-model","choices":[{"delta":{"role":null,"content":"hi"}}]}\n\n' +
          'data: [DONE]\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream);
      const sse = await readOutputStream(result);
      const [chunk] = dataObjects(sse) as Array<{
        model: string;
        choices: Array<{ delta: { role?: unknown; content: string } }>;
      }>;

      expect(chunk.model).toBe('upstream-model');
      expect('role' in chunk.choices[0].delta).toBe(false);
      expect(chunk.choices[0].delta.content).toBe('hi');
      expect(dataPayloads(sse)).toContain('[DONE]');
    });

    test('adds an empty choices array and strips cost on usage-only chunks', async () => {
      const upstream = sseResponse(
        'data: {"model":"upstream-model","usage":{"cost":1,"is_byok":true,"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{}}}\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream);
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

      expect(chunk.model).toBe('upstream-model');
      expect(chunk.choices).toEqual([]);
      expect(chunk.usage.cost).toBeUndefined();
      expect(chunk.usage.is_byok).toBeUndefined();
      expect(chunk.usage.prompt_tokens_details.cached_tokens).toBe(0);
    });

    test('forwards SSE comments as a processing keep-alive', async () => {
      const upstream = sseResponse(
        ': openrouter heartbeat\n\n' + 'data: {"model":"upstream-model","choices":[]}\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream);
      const sse = await readOutputStream(result);

      expect(sse).toContain(': KILO PROCESSING');
    });

    test('returns an empty body when upstream has no body', async () => {
      const upstream = new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await rewriteModelResponse_ChatCompletions(upstream);

      expect(await readOutputStream(result)).toBe('');
    });
  });
});

describe('rewriteModelResponse_Messages', () => {
  test.each([
    ['ResponseAborted', 'upstream_disconnect'],
    ['TimeoutError', 'timeout'],
  ])('emits an Anthropic SSE error for %s', async (errorName, errorType) => {
    const result = await rewriteModelResponse_Messages(
      failingResponse('text/event-stream', errorName)
    );
    const sse = await readOutputStream(result);

    expect(sse).toContain('event: error\n');
    expect(dataObjects(sse)).toEqual([
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: expect.any(String),
          error_type: errorType,
        },
      },
    ]);
  });

  test('strips cost fields for JSON responses', async () => {
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

    const result = await rewriteModelResponse_Messages(upstream);
    const json = await result.json();

    expect(json.model).toBe('upstream-model');
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

    const result = await rewriteModelResponse_Messages(upstream);

    expect(result.status).toBe(500);
    expect(await result.text()).toBe('}{');
  });

  test('rewrites message_start and message_delta usage and ignores [DONE]', async () => {
    const upstream = sseResponse(
      'data: {"type":"message_start","message":{"model":"upstream-model","usage":{"input_tokens":11,"output_tokens":0,"cost":0.1,"is_byok":true}}}\n\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":9,"cost":0.2,"is_byok":true},"delta":{}}\n\n' +
        'data: [DONE]\n\n'
    );

    const result = await rewriteModelResponse_Messages(upstream);
    const sse = await readOutputStream(result);
    const events = dataObjects(sse) as Array<{
      type: string;
      message?: {
        model: string;
        usage: { cost?: number; is_byok?: boolean; input_tokens: number };
      };
      usage?: { cost?: number; is_byok?: boolean; output_tokens: number };
    }>;

    expect(events[0].message?.model).toBe('upstream-model');
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

    const result = await rewriteModelResponse_Messages(upstream);
    const sse = await readOutputStream(result);

    expect(dataPayloads(sse)).not.toContain('[DONE]');
  });
});

describe('rewriteModelResponse_Responses', () => {
  test.each([
    ['ResponseAborted', 'upstream_disconnect'],
    ['TimeoutError', 'timeout'],
  ])('emits an OpenAI Responses SSE error for %s', async (errorName, errorType) => {
    const result = await rewriteModelResponse_Responses(
      failingResponse('text/event-stream', errorName)
    );
    const sse = await readOutputStream(result);

    expect(sse).toContain('event: error\n');
    expect(dataObjects(sse)).toEqual([
      {
        type: 'error',
        error: { code: errorType, message: expect.any(String) },
      },
    ]);
  });

  test('strips cost fields for JSON responses', async () => {
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

    const result = await rewriteModelResponse_Responses(upstream);
    const json = await result.json();

    expect(json.model).toBe('upstream-model');
    expect(json.usage.cost).toBeUndefined();
    expect(json.usage.is_byok).toBeUndefined();
    expect(json.usage.prompt_tokens_details.cached_tokens).toBe(0);
  });

  test('strips the nested response usage in stream events and emits [DONE]', async () => {
    const upstream = sseResponse(
      'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"model":"upstream-model","usage":{"cost":0.5,"is_byok":true,"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"prompt_tokens_details":{"cached_tokens":1}}}}\n\n' +
        'data: [DONE]\n\n'
    );

    const result = await rewriteModelResponse_Responses(upstream);
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

    expect(event.response.model).toBe('upstream-model');
    expect(event.response.usage.cost).toBeUndefined();
    expect(event.response.usage.is_byok).toBeUndefined();
    expect(event.response.usage.prompt_tokens_details.cached_tokens).toBe(1);
    expect(sse).toContain('event: response.completed');
    expect(dataPayloads(sse)).toContain('[DONE]');
  });
});
