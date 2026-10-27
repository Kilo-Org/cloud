import { test, describe, expect, afterEach } from '@jest/globals';
import { captureException } from '@sentry/nextjs';
import {
  parseMessagesMicrodollarUsageFromStream,
  parseMessagesMicrodollarUsageFromString,
  processMessagesApiUsage,
} from './processUsage.messages';
import { verifyApproval } from '@kilocode/web-shared/tests/helpers/approval.helper';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

const sampleDir = join(process.cwd(), 'src/tests/sample');

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('processMessagesApiUsage', () => {
  const coreProps = {
    messageId: 'test-message-id',
    model: 'test-model',
    responseContent: 'test-response',
    hasError: false,
    inference_provider: 'Provider',
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: 200,
  };

  test('correctly processes OpenRouter usage for a non-byok case', () => {
    const usage = {
      input_tokens: 50,
      output_tokens: 100,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      output_tokens_details: null,
      cost: 0.001,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.7 },
    };

    const result = processMessagesApiUsage(usage, null, coreProps, 'openrouter');

    expect(result.cost_mUsd).toBe(1000);
    expect(result.is_byok).toBe(false);
    expect(result.inputTokens).toBe(65); // 50 + 10 + 5
    expect(result.outputTokens).toBe(100);
    expect(result.cacheHitTokens).toBe(10);
    expect(result.cacheWriteTokens).toBe(5);
  });

  test('correctly processes OpenRouter usage for a byok case', () => {
    const usage = {
      input_tokens: 50,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      output_tokens_details: null,
      cost: 0.001,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.02 },
    };

    const result = processMessagesApiUsage(usage, null, coreProps, 'openrouter');

    expect(result.cost_mUsd).toBe(20000);
    expect(result.is_byok).toBe(true);
  });

  test('correctly processes Vercel usage with marketCost', () => {
    const usage = {
      input_tokens: 25,
      output_tokens: 6,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      output_tokens_details: null,
    };
    const providerMetadata = {
      gateway: { routing: { finalProvider: 'anthropic' }, cost: '0', marketCost: '0.000375' },
    };

    const result = processMessagesApiUsage(usage, providerMetadata, coreProps, 'openrouter');

    expect(result.cost_mUsd).toBe(375); // toMicrodollars(0.000375)
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(6);
    expect(result.cacheHitTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });

  test('extracts is_byok=true from Vercel modelAttempts credentialType', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      output_tokens_details: null,
    };
    const providerMetadata = {
      gateway: {
        routing: {
          finalProvider: 'bedrock',
          modelAttempts: [
            {
              success: true,
              providerAttempts: [{ provider: 'bedrock', credentialType: 'byok', success: true }],
            },
          ],
        },
        cost: '0',
        marketCost: '0.000402',
      },
    };

    const result = processMessagesApiUsage(usage, providerMetadata, coreProps, 'openrouter');

    expect(result.is_byok).toBe(true);
    expect(result.cost_mUsd).toBe(402);
  });

  test('extracts is_byok=false from Vercel system credentialType', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      output_tokens_details: null,
    };
    const providerMetadata = {
      gateway: {
        routing: {
          finalProvider: 'bedrock',
          modelAttempts: [
            {
              success: true,
              providerAttempts: [{ provider: 'bedrock', credentialType: 'system', success: true }],
            },
          ],
        },
        cost: '0',
        marketCost: '0.000402',
      },
    };

    const result = processMessagesApiUsage(usage, providerMetadata, coreProps, 'openrouter');

    expect(result.is_byok).toBe(false);
  });

  test('picks the successful provider attempt when earlier attempts failed', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      output_tokens_details: null,
    };
    const providerMetadata = {
      gateway: {
        routing: {
          finalProvider: 'anthropic',
          modelAttempts: [
            {
              success: true,
              providerAttempts: [
                { provider: 'bedrock', credentialType: 'byok', success: false },
                { provider: 'anthropic', credentialType: 'system', success: true },
              ],
            },
          ],
        },
        cost: '0',
        marketCost: '0.000402',
      },
    };

    const result = processMessagesApiUsage(usage, providerMetadata, coreProps, 'openrouter');

    expect(result.is_byok).toBe(false);
  });

  test('prefers OpenRouter zero cost over Vercel metadata and adds cache tokens to input', () => {
    const usage = {
      input_tokens: 20,
      output_tokens: 4,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      server_tool_use: null,
      output_tokens_details: null,
      cost: 0,
      is_byok: false,
    };
    const providerMetadata = {
      gateway: { routing: { finalProvider: 'anthropic' }, marketCost: '0.5' },
    };

    const result = processMessagesApiUsage(usage, providerMetadata, coreProps, 'openrouter');

    expect(result).toEqual({
      inputTokens: 30,
      outputTokens: 4,
      cacheHitTokens: 7,
      cacheWriteTokens: 3,
      cost_mUsd: 0,
      is_byok: false,
    });
  });

  test('returns zero cost when no usage or metadata is provided', () => {
    const result = processMessagesApiUsage(null, null, coreProps, 'openrouter');

    expect(result.cost_mUsd).toBe(0);
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe('parseMessagesMicrodollarUsageFromStream approval tests', () => {
  // Usage processing times the response chunks; a fixed clock keeps the approved output stable.
  let performanceNow: jest.SpiedFunction<typeof performance.now>;
  beforeEach(() => {
    performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    performanceNow.mockRestore();
  });

  const vercelMessages = 'vercel-messages.log.resp.sse';
  test(vercelMessages, async () => {
    const inputFile = join(sampleDir, vercelMessages);
    const nodeStream = createReadStream(inputFile);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'vercel',
      200,
      false
    );
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});

describe('parseMessagesMicrodollarUsageFromStream', () => {
  test.each([false, true])(
    'retains Vercel start-frame cost and routing metadata with a final delta=%s',
    async hasDelta => {
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'generation-id',
            model: 'upstream-model',
            usage: { input_tokens: 3, output_tokens: 1 },
            provider_metadata: {
              gateway: {
                marketCost: '0.12',
                routing: { canonicalSlug: 'resolved-model', finalProvider: 'anthropic' },
              },
            },
          },
        },
        ...(hasDelta
          ? [
              {
                type: 'message_delta',
                usage: { output_tokens: 2 },
                delta: { stop_reason: 'end_turn' },
              },
            ]
          : []),
      ];
      const result = await parseMessagesMicrodollarUsageFromStream(
        streamFromText(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')),
        'fake-user-id',
        undefined,
        'vercel',
        200,
        false
      );

      expect(result).toMatchObject({
        cost_mUsd: 120_000,
        model: 'resolved-model',
        inference_provider: 'anthropic',
        inputTokens: 3,
        outputTokens: hasDelta ? 2 : 1,
      });
    }
  );

  test('records the successful Vercel routed model instead of the message start model', async () => {
    const stream = streamFromText(
      'event: message_start\n' +
        'data: {"type":"message_start","message":{"id":"generation-id","type":"message","role":"assistant","content":[],"model":"anthropic/claude-fable-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
        'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":25,"output_tokens":724},"provider_metadata":{"gateway":{"routing":{"canonicalSlug":"anthropic/claude-fable-5","finalProvider":"anthropic","modelAttempts":[{"canonicalSlug":"anthropic/claude-fable-5","success":false},{"canonicalSlug":"anthropic/claude-opus-4.8","success":true}]},"cost":"0","marketCost":"0.018225"}}}\n\n' +
        'event: message_stop\n' +
        'data: {"type":"message_stop"}\n\n'
    );

    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'vercel',
      200,
      false
    );

    expect(result.model).toBe('anthropic/claude-opus-4.8');
  });

  test('records message_start input tokens when the stream ends before message_delta', async () => {
    const stream = streamFromText(
      'event: message_start\n' +
        'data: {"type":"message_start","message":{"id":"generation-id","type":"message","role":"assistant","content":[],"model":"anthropic/claude-sonnet-4-6:optimized","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":500,"output_tokens":1}}}\n\n' +
        'event: content_block_delta\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
        'event: content_block_stop\n' +
        'data: {"type":"content_block_stop","index":0}\n\n'
    );

    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'martian',
      200,
      false
    );

    expect(result).toMatchObject({
      inputTokens: 2000,
      cacheHitTokens: 500,
      cacheWriteTokens: 300,
      outputTokens: 1,
    });
  });

  test('keeps message_start input tokens that message_delta omits', async () => {
    const stream = streamFromText(
      'event: message_start\n' +
        'data: {"type":"message_start","message":{"id":"generation-id","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":500,"output_tokens":1}}}\n\n' +
        'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":null,"cache_creation_input_tokens":null,"cache_read_input_tokens":null,"output_tokens":42}}\n\n'
    );

    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'martian',
      200,
      false
    );

    expect(result).toMatchObject({
      inputTokens: 2000,
      cacheHitTokens: 500,
      cacheWriteTokens: 300,
      outputTokens: 42,
    });
  });

  test('prefers message_delta input tokens over message_start', async () => {
    const stream = streamFromText(
      'event: message_start\n' +
        'data: {"type":"message_start","message":{"id":"generation-id","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
        'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":25,"output_tokens":724}}\n\n'
    );

    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'martian',
      200,
      false
    );

    expect(result).toMatchObject({ inputTokens: 25, outputTokens: 724 });
  });

  test('records stream error events as errored timeout usage', async () => {
    const stream = streamFromText(
      'event: error\n' +
        'data: {"type":"error","error":{"type":"api_error","message":"Upstream idle timeout exceeded","error_type":"timeout"}}\n\n'
    );

    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'openrouter',
      200,
      false
    );

    expect(result.hasError).toBe(true);
    expect(result.finish_reason).toBe('timeout');
    expect(result.status_code).toBe(200);
    expect(result.cost_mUsd).toBe(0);
  });

  test('falls back to error finish reason when stream error has no error_type', async () => {
    const stream = streamFromText(
      'event: error\n' + 'data: {"type":"error","error":{"message":"Upstream failed"}}\n\n'
    );

    const result = await parseMessagesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'openrouter',
      200,
      false
    );

    expect(result.hasError).toBe(true);
    expect(result.finish_reason).toBe('error');
  });

  describe('upstream error reporting', () => {
    afterEach(() => {
      jest.mocked(captureException).mockClear();
      jest.restoreAllMocks();
    });

    const parseError = (error: object, usesUserCredentials: boolean) =>
      parseMessagesMicrodollarUsageFromStream(
        streamFromText(`event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`),
        'fake-user-id',
        undefined,
        'openrouter',
        200,
        usesUserCredentials
      );

    test('logs transient stream errors without reporting to Sentry', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await parseError(
        {
          type: 'api_error',
          error_type: 'provider_unavailable',
          message: 'JSON error injected into SSE stream',
        },
        false
      );

      expect(captureException).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Messages API stream error: JSON error injected into SSE stream',
        expect.objectContaining({
          source: 'messages_sse_processing',
          error_type: 'provider_unavailable',
          provider: 'openrouter',
        })
      );
    });

    test('reports authentication errors on Kilo credentials to Sentry', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await parseError({ type: 'authentication_error', message: 'invalid x-api-key' }, false);

      expect(warn).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledWith(
        new Error('Messages API stream error: invalid x-api-key'),
        expect.objectContaining({ tags: { source: 'messages_sse_processing' } })
      );
    });

    test('only logs authentication errors on user credentials', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await parseError({ type: 'authentication_error', message: 'invalid x-api-key' }, true);

      expect(captureException).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('parseMessagesMicrodollarUsageFromString approval tests', () => {
  const vercelMessagesJson = 'vercel-messages.log.resp.json';
  test(vercelMessagesJson, async () => {
    const inputFile = join(sampleDir, vercelMessagesJson);
    const jsonString = await readFile(inputFile, 'utf-8');
    const result = parseMessagesMicrodollarUsageFromString(jsonString, 200, 'openrouter');
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});
