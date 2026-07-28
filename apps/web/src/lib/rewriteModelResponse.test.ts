import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  rewriteModelResponse_ChatCompletions,
  rewriteModelResponse_Messages,
  rewriteModelResponse_Responses,
  rewriteModelResponse,
  type RequestLoggingParams,
} from './rewriteModelResponse';
import { isDynamicallyOptedIntoRequestLogging } from '@/lib/ai-gateway/request-logging-opt-ins';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/request-logging-opt-ins', () => ({
  isDynamicallyOptedIntoRequestLogging: jest.fn(async () => false),
}));

const mockedOptIn = jest.mocked(isDynamicallyOptedIntoRequestLogging);

beforeEach(() => {
  mockedOptIn.mockClear();
});

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
    test('tracks event progress every 30 seconds and clears the interval', async () => {
      const intervalHandle = setTimeout(() => {}, 0);
      clearTimeout(intervalHandle);
      const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(intervalHandle);
      const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
      const encoder = new TextEncoder();
      const upstreamController: { current?: ReadableStreamDefaultController<Uint8Array> } = {};
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamController.current = controller;
            controller.enqueue(
              encoder.encode('data: {"id":"gen-chat","model":"upstream-model","choices":[]}\n\n')
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );

      try {
        const result = await rewriteModelResponse_ChatCompletions(upstream);
        const reader = result.body?.getReader();
        expect(reader).toBeDefined();
        await reader?.read();
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);

        upstreamController.current?.close();
        await reader?.read();
        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    test.each([
      ['ResponseAborted', 'upstream_disconnect'],
      ['TimeoutError', 'timeout'],
    ])('emits a structured SSE error for %s', async (errorName, errorType) => {
      const upstream = failingResponse(
        'text/event-stream',
        errorName,
        'data: {"id":"gen-chat","model":"upstream-model","choices":[]}\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream);
      const sse = await readOutputStream(result);
      const events = dataObjects(sse) as Array<{ error?: { code: number; type: string } }>;

      expect(events[0]).toMatchObject({ model: 'upstream-model' });
      expect(events[1]).toMatchObject({ id: 'gen-chat' });
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
      failingResponse(
        'text/event-stream',
        errorName,
        'data: {"type":"message_start","message":{"id":"gen-message","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
      )
    );
    const sse = await readOutputStream(result);

    expect(sse).toContain('event: error\n');
    expect(dataObjects(sse)).toEqual([
      {
        type: 'message_start',
        message: {
          id: 'gen-message',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        id: 'gen-message',
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
      failingResponse(
        'text/event-stream',
        errorName,
        'data: {"type":"response.created","sequence_number":4,"response":{"id":"gen-response"}}\n\n'
      )
    );
    const sse = await readOutputStream(result);

    expect(sse).toContain('event: error\n');
    expect(dataObjects(sse)).toEqual([
      {
        type: 'response.created',
        sequence_number: 4,
        response: { id: 'gen-response' },
      },
      {
        id: 'gen-response',
        type: 'error',
        sequence_number: 5,
        error: {
          type: errorType,
          code: errorType === 'timeout' ? '504' : '503',
          message: expect.any(String),
        },
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

function makeLogging(overrides?: Partial<RequestLoggingParams>): RequestLoggingParams {
  return {
    user: null,
    organization_id: null,
    session_id: null,
    vercel_request_id: null,
    request: { body: {} } as unknown as RequestLoggingParams['request'],
    ...overrides,
  };
}

describe('rewriteModelResponse', () => {
  test('rewrites paid-model Kilo organization traffic without stripping cost', async () => {
    const result = await rewriteModelResponse(
      jsonResponse({
        model: 'openai/gpt-5',
        usage: {
          cost: 0.5,
          cost_details: { upstream_inference_cost: 0.4 },
          is_byok: false,
        },
      }),
      'openai/gpt-5',
      'openrouter',
      'chat_completions',
      makeLogging({ organization_id: KILO_ORGANIZATION_ID })
    );

    expect(result).not.toBeNull();
    expect(await result?.json()).toMatchObject({
      usage: {
        cost: 0.5,
        cost_details: { upstream_inference_cost: 0.4 },
        is_byok: false,
      },
    });
  });

  test('does not rewrite paid-model traffic for other organizations', async () => {
    const result = await rewriteModelResponse(
      jsonResponse({ model: 'openai/gpt-5' }),
      'openai/gpt-5',
      'openrouter',
      'chat_completions',
      makeLogging({ organization_id: '00000000-0000-0000-0000-000000000000' })
    );

    expect(result).toBeNull();
  });

  test('continues stripping cost for free models outside the Kilo organization', async () => {
    const result = await rewriteModelResponse(
      jsonResponse({
        model: 'google/gemma-4-26b-a4b-it:free',
        usage: { cost: 0, is_byok: false },
      }),
      'google/gemma-4-26b-a4b-it:free',
      'openrouter',
      'chat_completions',
      makeLogging()
    );

    expect(result).not.toBeNull();
    expect(await result?.json()).toEqual({
      model: 'google/gemma-4-26b-a4b-it:free',
      usage: {},
    });
  });

  test('processes responses it would normally skip when request logging is enabled', async () => {
    mockedOptIn.mockResolvedValueOnce(true);
    const result = await rewriteModelResponse(
      jsonResponse({ model: 'openai/gpt-5' }),
      'openai/gpt-5',
      'openrouter',
      'chat_completions',
      makeLogging({ organization_id: '00000000-0000-0000-0000-000000000000' })
    );

    expect(result).not.toBeNull();
  });
});

function makeCapture() {
  return { setBody: jest.fn(), setReadError: jest.fn() };
}

describe('request log capture', () => {
  test.each(rewriters)('%s: captures the raw JSON body', async (_name, rewrite) => {
    const capture = makeCapture();
    const body = { model: 'upstream-model' };

    const result = await rewrite(jsonResponse(body), true, capture);

    expect(result.status).toBe(200);
    expect(capture.setBody).toHaveBeenCalledTimes(1);
    expect(capture.setBody).toHaveBeenCalledWith(JSON.stringify(body));
    expect(capture.setReadError).not.toHaveBeenCalled();
  });

  test.each(rewriters)('%s: captures the raw event stream', async (_name, rewrite) => {
    const capture = makeCapture();
    const sseBody =
      'data: {"id":"gen-1","model":"upstream-model","choices":[]}\n\n' + 'data: [DONE]\n\n';

    const result = await rewrite(sseResponse(sseBody), true, capture);
    await readOutputStream(result);

    expect(capture.setBody).toHaveBeenCalledTimes(1);
    expect(capture.setBody).toHaveBeenCalledWith(sseBody);
    expect(capture.setReadError).not.toHaveBeenCalled();
  });

  test.each(rewriters)(
    '%s: captures an empty body when upstream has no body',
    async (_name, rewrite) => {
      const capture = makeCapture();

      const result = await rewrite(
        new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
        true,
        capture
      );
      await readOutputStream(result);

      expect(capture.setBody).toHaveBeenCalledWith('');
      expect(capture.setReadError).not.toHaveBeenCalled();
    }
  );

  test.each(rewriters)(
    '%s: records a read error with the chunks received before the stream failed',
    async (_name, rewrite) => {
      const capture = makeCapture();
      const receivedChunks = 'data: {"id":"gen-1","choices":[]}\n\n';

      const result = await rewrite(
        failingResponse('text/event-stream', 'ResponseAborted', receivedChunks),
        true,
        capture
      );
      await readOutputStream(result);

      expect(capture.setReadError).toHaveBeenCalledTimes(1);
      expect(capture.setReadError).toHaveBeenCalledWith(expect.any(Error), receivedChunks);
      expect(capture.setBody).not.toHaveBeenCalled();
    }
  );

  test.each(rewriters)(
    '%s: records a read error without a partial body when the stream fails immediately',
    async (_name, rewrite) => {
      const capture = makeCapture();

      const result = await rewrite(
        failingResponse('text/event-stream', 'ResponseAborted'),
        true,
        capture
      );
      await readOutputStream(result);

      expect(capture.setReadError).toHaveBeenCalledTimes(1);
      expect(capture.setReadError).toHaveBeenCalledWith(expect.any(Error), undefined);
      expect(capture.setBody).not.toHaveBeenCalled();
    }
  );

  test.each(rewriters)(
    '%s: records a read error when a JSON body cannot be read',
    async (_name, rewrite) => {
      const capture = makeCapture();

      const result = await rewrite(
        failingResponse('application/json', 'TimeoutError'),
        true,
        capture
      );

      expect(result.status).toBe(503);
      expect(capture.setReadError).toHaveBeenCalledTimes(1);
      expect(capture.setBody).not.toHaveBeenCalled();
    }
  );

  test('records a read error when the response stream is cancelled', async () => {
    const capture = makeCapture();
    const upstream = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      headers: { 'content-type': 'text/event-stream' },
    });

    const result = await rewriteModelResponse_ChatCompletions(upstream, true, capture);
    const reader = result.body?.getReader();
    await reader?.cancel();

    expect(capture.setReadError).toHaveBeenCalled();
    expect(capture.setBody).not.toHaveBeenCalled();
  });
});
