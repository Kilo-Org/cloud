import { describe, test, expect } from '@jest/globals';
import {
  rewriteJsonResponse,
  type RequestLogCapture,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';

function params(response: Response, mutate: (body: { value?: number }) => void) {
  const capture: RequestLogCapture = {
    setGenerationId: jest.fn(),
    setBody: jest.fn(),
    setReadError: jest.fn(),
  };
  return {
    capture,
    args: {
      response,
      headers: new Headers({ 'content-type': 'application/json', 'x-test': 'kept' }),
      vercelRequestId: null,
      capture,
      reasoningEffort: null,
      mutate,
    },
  };
}

function jsonResponse(text: string, init: ResponseInit = {}) {
  return new Response(text, {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('rewriteJsonResponse', () => {
  test('returns the mutated body with the upstream status and the given headers', async () => {
    const { args, capture } = params(jsonResponse('{"value":1}'), body => {
      body.value = 2;
    });

    const result = await rewriteJsonResponse(args);

    expect(result.status).toBe(201);
    expect(result.statusText).toBe('Created');
    expect(result.headers.get('x-test')).toBe('kept');
    expect(await result.json()).toEqual({ value: 2 });
    expect(capture.setBody).toHaveBeenCalledWith('{"value":1}');
  });

  test.each(['not-json{', ''])('passes the invalid JSON body %j through', async text => {
    const mutate = jest.fn();
    const { args } = params(jsonResponse(text), mutate);

    const result = await rewriteJsonResponse(args);

    expect(result.status).toBe(201);
    expect(await result.text()).toBe(text);
    expect(mutate).not.toHaveBeenCalled();
  });

  test.each(['null', '[{"value":1}]', '"text"', '7', 'false'])(
    'passes the non-object JSON body %s through without mutating it',
    async text => {
      const mutate = jest.fn();
      const { args } = params(jsonResponse(text), mutate);

      const result = await rewriteJsonResponse(args);

      expect(result.status).toBe(201);
      expect(await result.text()).toBe(text);
      expect(mutate).not.toHaveBeenCalled();
    }
  );

  test('returns the read-error response and settles the capture when the body times out', async () => {
    const error = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(error);
      },
    });
    const mutate = jest.fn();
    const { args, capture } = params(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
      mutate
    );

    const result = await rewriteJsonResponse(args);

    expect(result.status).toBe(503);
    expect((await result.json()).error_type).toBe('timeout');
    expect(capture.setReadError).toHaveBeenCalledWith(error);
    expect(capture.setBody).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
