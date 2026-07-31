import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  rewriteModelResponse_ChatCompletions,
  rewriteModelResponse_Messages,
  rewriteModelResponse_Responses,
  rewriteModelResponse,
  type RequestLoggingParams,
} from './rewriteModelResponse';
import { isDynamicallyOptedIntoRequestLogging } from '@/lib/ai-gateway/request-logging-opt-ins';
import { QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/custom-pricing';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import { logExceptInTest } from '@/lib/utils.server';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/request-logging-opt-ins', () => ({
  isDynamicallyOptedIntoRequestLogging: jest.fn(async () => false),
}));

jest.mock('@/lib/utils.server', () => ({
  ...(jest.requireActual('@/lib/utils.server') as Record<string, unknown>),
  logExceptInTest: jest.fn(),
}));

const mockedOptIn = jest.mocked(isDynamicallyOptedIntoRequestLogging);
const mockedLog = jest.mocked(logExceptInTest);

beforeEach(() => {
  mockedOptIn.mockClear();
  mockedLog.mockClear();
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

function hangingSseResponse(body: string): { response: Response; cancel: jest.Mock } {
  const encoder = new TextEncoder();
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
    },
    cancel,
  });

  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    cancel,
  };
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
    const result = await rewrite(failingResponse('application/json', errorName), true, null, null);

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: expect.stringContaining(messageFragment),
      error_type: errorType,
      message: expect.stringContaining(messageFragment),
    });
  });

  test('includes the vercel request id only in the JSON read error message', async () => {
    const result = await rewrite(
      failingResponse('application/json', 'ResponseAborted'),
      true,
      null,
      'iad1::iad1::request-id'
    );

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error:
        'The upstream provider disconnected while sending the response. (request id: iad1::iad1::request-id)',
      error_type: 'upstream_disconnect',
      message:
        'The upstream provider disconnected while sending the response. (request id: iad1::iad1::request-id)',
    });
  });

  test('includes the vercel request id only in the stream error message', async () => {
    const result = await rewrite(
      failingResponse('text/event-stream', 'ResponseAborted'),
      true,
      null,
      'iad1::iad1::request-id'
    );
    const events = dataObjects(await readOutputStream(result)) as {
      error: { message: string };
    }[];

    expect(events).toHaveLength(1);
    expect(events[0].error.message).toBe(
      'The upstream provider disconnected while sending the response. (request id: iad1::iad1::request-id)'
    );
    expect(events[0].error).not.toHaveProperty('vercel_request_id');
  });

  test('omits the request id suffix when no vercel request id is available', async () => {
    const result = await rewrite(
      failingResponse('text/event-stream', 'ResponseAborted'),
      true,
      null,
      null
    );
    const events = dataObjects(await readOutputStream(result)) as {
      error: { message: string };
    }[];

    expect(events[0].error.message).toBe(
      'The upstream provider disconnected while sending the response.'
    );
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

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
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

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
      const json = await result.json();

      expect(json.usage.prompt_tokens_details.cached_tokens).toBe(0);
    });

    test('passes through invalid JSON bodies unchanged and preserves status', async () => {
      const upstream = new Response('not-json{', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'application/json' },
      });

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);

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
        const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
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

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
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

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
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

    test('does not treat a null error field as terminal', async () => {
      const upstream = sseResponse(
        'data: {"id":"gen-chat","error":null,"choices":[]}\n\n' +
          'data: {"id":"gen-chat","choices":[{"delta":{"content":"still streaming"}}]}\n\n' +
          'data: [DONE]\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
      const sse = await readOutputStream(result);

      expect(sse).toContain('still streaming');
      expect(dataPayloads(sse)).toContain('[DONE]');
    });

    test('cancels upstream and closes immediately after [DONE]', async () => {
      const capture = makeCapture();
      const body =
        'data: {"id":"gen-chat","model":"upstream-model","choices":[]}\n\n' +
        'data: [DONE]\n\n' +
        'data: {"id":"ignored","model":"upstream-model","choices":[]}\n\n';
      const { response: upstream, cancel } = hangingSseResponse(body);

      const result = await rewriteModelResponse_ChatCompletions(
        upstream,
        true,
        capture,
        'iad1::terminal-request'
      );
      const sse = await readOutputStream(result);

      expect(dataObjects(sse)).toEqual([{ id: 'gen-chat', model: 'upstream-model', choices: [] }]);
      expect(dataPayloads(sse)).toContain('[DONE]');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(capture.setBody).toHaveBeenCalledWith(body);
      expect(capture.setReadError).not.toHaveBeenCalled();
      expect(mockedLog).toHaveBeenCalledWith(
        '[rewriteModelResponse] received terminal stream event',
        {
          kind: 'chat_completions',
          eventType: '[DONE]',
          generationId: 'gen-chat',
          vercelRequestId: 'iad1::terminal-request',
        }
      );
    });

    test('adds an empty choices array and strips cost on usage-only chunks', async () => {
      const upstream = sseResponse(
        'data: {"model":"upstream-model","usage":{"cost":1,"is_byok":true,"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{}}}\n\n'
      );

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
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

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);
      const sse = await readOutputStream(result);

      expect(sse).toContain(': KILO PROCESSING');
    });

    test('returns an empty body when upstream has no body', async () => {
      const upstream = new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await rewriteModelResponse_ChatCompletions(upstream, true, null, null);

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
      ),
      true,
      null,
      null
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

    const result = await rewriteModelResponse_Messages(upstream, true, null, null);
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

    const result = await rewriteModelResponse_Messages(upstream, true, null, null);

    expect(result.status).toBe(500);
    expect(await result.text()).toBe('}{');
  });

  test('rewrites message_start and message_delta usage and ignores [DONE]', async () => {
    const upstream = sseResponse(
      'data: {"type":"message_start","message":{"model":"upstream-model","usage":{"input_tokens":11,"output_tokens":0,"cost":0.1,"is_byok":true}}}\n\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":9,"cost":0.2,"is_byok":true},"delta":{}}\n\n' +
        'data: [DONE]\n\n'
    );

    const result = await rewriteModelResponse_Messages(upstream, true, null, null);
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

    const result = await rewriteModelResponse_Messages(upstream, true, null, null);
    const sse = await readOutputStream(result);

    expect(dataPayloads(sse)).not.toContain('[DONE]');
  });

  test('cancels upstream and closes immediately after message_stop', async () => {
    const capture = makeCapture();
    const body =
      'event: message_stop\ndata: {"type":"message_stop"}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":10},"delta":{}}\n\n';
    const { response: upstream, cancel } = hangingSseResponse(body);

    const result = await rewriteModelResponse_Messages(upstream, true, capture, null);
    const sse = await readOutputStream(result);

    expect(dataObjects(sse)).toEqual([{ type: 'message_stop' }]);
    expect(dataPayloads(sse)).not.toContain('[DONE]');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(capture.setBody).toHaveBeenCalledWith(body);
    expect(capture.setReadError).not.toHaveBeenCalled();
    expect(mockedLog).toHaveBeenCalledWith(
      '[rewriteModelResponse] received terminal stream event',
      {
        kind: 'messages',
        eventType: 'message_stop',
        generationId: '<none>',
        vercelRequestId: '<none>',
      }
    );
  });

  test('cancels upstream and closes immediately after a compatible [DONE] sentinel', async () => {
    const capture = makeCapture();
    const body =
      'data: [DONE]\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":10},"delta":{}}\n\n';
    const { response: upstream, cancel } = hangingSseResponse(body);

    const result = await rewriteModelResponse_Messages(upstream, true, capture, null);
    const sse = await readOutputStream(result);

    expect(dataObjects(sse)).toEqual([]);
    expect(dataPayloads(sse)).toEqual(['[DONE]']);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(capture.setBody).toHaveBeenCalledWith(body);
    expect(capture.setReadError).not.toHaveBeenCalled();
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
      ),
      true,
      null,
      null
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

    const result = await rewriteModelResponse_Responses(upstream, true, null, null);
    const json = await result.json();

    expect(json.model).toBe('upstream-model');
    expect(json.usage.cost).toBeUndefined();
    expect(json.usage.is_byok).toBeUndefined();
    expect(json.usage.prompt_tokens_details.cached_tokens).toBe(0);
  });

  test('strips nested response usage and closes after the completed event', async () => {
    const upstream = sseResponse(
      'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"model":"upstream-model","usage":{"cost":0.5,"is_byok":true,"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"prompt_tokens_details":{"cached_tokens":1}}}}\n\n' +
        'data: [DONE]\n\n'
    );

    const result = await rewriteModelResponse_Responses(upstream, true, null, null);
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
    expect(dataPayloads(sse)).not.toContain('[DONE]');
  });

  test.each(['response.completed', 'response.incomplete', 'response.failed'])(
    'forwards %s, cancels upstream, and closes without waiting for EOF',
    async type => {
      const capture = makeCapture();
      const body =
        `event: ${type}\ndata: ${JSON.stringify({ type })}\n\n` +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ignored"}\n\n';
      const { response: upstream, cancel } = hangingSseResponse(body);

      const result = await rewriteModelResponse_Responses(upstream, true, capture, null);
      const sse = await readOutputStream(result);

      expect(dataObjects(sse)).toEqual([{ type }]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(capture.setBody).toHaveBeenCalledWith(body);
      expect(capture.setReadError).not.toHaveBeenCalled();
      expect(mockedLog).toHaveBeenCalledWith(
        '[rewriteModelResponse] received terminal stream event',
        {
          kind: 'responses',
          eventType: type,
          generationId: '<none>',
          vercelRequestId: '<none>',
        }
      );
    }
  );
});

describe.each([
  [
    'Chat Completions',
    'chat_completions',
    rewriteModelResponse_ChatCompletions,
    'data: {"id":"gen-chat","choices":[]}\n\n',
    'data: {"error":{"code":429,"message":"rate limited"}}\n\n',
    'gen-chat',
  ],
  [
    'Messages',
    'messages',
    rewriteModelResponse_Messages,
    'event: message_start\ndata: {"type":"message_start","message":{"id":"gen-message","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"rate limited"}}\n\n',
    'gen-message',
  ],
  [
    'Responses',
    'responses',
    rewriteModelResponse_Responses,
    'event: response.created\ndata: {"type":"response.created","response":{"id":"gen-response"}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"server_error","message":"rate limited"}}\n\n',
    'gen-response',
  ],
] as const)(
  '%s terminal stream errors',
  (_name, kind, rewrite, initialEvent, errorEvent, generationId) => {
    test('logs the error event and closes without waiting for EOF', async () => {
      const capture = makeCapture();
      const body = initialEvent + errorEvent + 'data: {"ignored":true}\n\n';
      const { response: upstream, cancel } = hangingSseResponse(body);

      const result = await rewrite(upstream, true, capture, 'iad1::error-request');
      const sse = await readOutputStream(result);

      expect(sse).toContain('rate limited');
      expect(sse).not.toContain('ignored');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(capture.setBody).toHaveBeenCalledWith(body);
      expect(capture.setReadError).not.toHaveBeenCalled();
      expect(mockedLog).toHaveBeenCalledWith(
        '[rewriteModelResponse] received terminal stream event',
        {
          kind,
          eventType: 'error',
          generationId,
          vercelRequestId: 'iad1::error-request',
        }
      );
    });
  }
);

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

  test('rewrites paid-model traffic for other organizations without stripping cost', async () => {
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
      makeLogging({ organization_id: '00000000-0000-0000-0000-000000000000' })
    );

    expect(await result.json()).toMatchObject({
      usage: {
        cost: 0.5,
        cost_details: { upstream_inference_cost: 0.4 },
        is_byok: false,
      },
    });
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

  test('strips cost for models with custom pricing', async () => {
    const result = await rewriteModelResponse(
      jsonResponse({
        model: QWEN37_PLUS_MODEL_ID,
        usage: { cost: 0.5, cost_details: { upstream_inference_cost: 0.4 }, is_byok: false },
      }),
      QWEN37_PLUS_MODEL_ID,
      'openrouter',
      'chat_completions',
      makeLogging()
    );

    // The upstream-reported cost does not reflect the custom pricing, so it
    // must be removed just like for free models.
    expect(await result.json()).toEqual({
      model: QWEN37_PLUS_MODEL_ID,
      usage: {},
    });
  });

  test('processes paid-model responses when request logging is enabled', async () => {
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

    const result = await rewrite(jsonResponse(body), true, capture, null);

    expect(result.status).toBe(200);
    expect(capture.setBody).toHaveBeenCalledTimes(1);
    expect(capture.setBody).toHaveBeenCalledWith(JSON.stringify(body));
    expect(capture.setReadError).not.toHaveBeenCalled();
  });

  test.each(rewriters)('%s: captures the raw event stream', async (_name, rewrite) => {
    const capture = makeCapture();
    const sseBody =
      'data: {"id":"gen-1","model":"upstream-model","choices":[]}\n\n' + 'data: [DONE]\n\n';

    const result = await rewrite(sseResponse(sseBody), true, capture, null);
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
        capture,
        null
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
        capture,
        null
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
        capture,
        null
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
        capture,
        null
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

    const result = await rewriteModelResponse_ChatCompletions(upstream, true, capture, null);
    const reader = result.body?.getReader();
    await reader?.cancel();

    expect(capture.setReadError).toHaveBeenCalledWith(expect.any(Error), undefined);
    expect(capture.setBody).not.toHaveBeenCalled();
  });

  test.each(rewriters)(
    '%s: records the chunks received before the response stream is cancelled',
    async (_name, rewrite) => {
      const capture = makeCapture();
      const receivedChunks = 'data: {"id":"gen-1","choices":[]}\n\n';
      const { response: upstream } = hangingSseResponse(receivedChunks);

      const result = await rewrite(upstream, true, capture, null);
      const reader = result.body?.getReader();
      await reader?.read();
      await reader?.cancel();

      expect(capture.setReadError).toHaveBeenCalledTimes(1);
      expect(capture.setReadError).toHaveBeenCalledWith(expect.any(Error), receivedChunks);
      expect(capture.setBody).not.toHaveBeenCalled();
    }
  );
});
