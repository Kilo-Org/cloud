import { test, describe, expect } from '@jest/globals';
import {
  extractResponsesPromptInfo,
  parseResponsesMicrodollarUsageFromStream,
  parseResponsesMicrodollarUsageFromString,
  processResponsesApiUsage,
} from './processUsage.responses';
import { verifyApproval } from '@kilocode/web-shared/tests/helpers/approval.helper';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { GatewayResponsesRequest } from './providers/openrouter/types';

const sampleDir = join(process.cwd(), 'src/tests/sample');

describe('extractResponsesPromptInfo', () => {
  test('extracts system and developer input messages', () => {
    expect(
      extractResponsesPromptInfo({
        model: 'openai/gpt-5.4',
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: 'You are Kilo Code.' }],
          },
          { role: 'developer', content: 'Follow the repository instructions.' },
          { role: 'user', content: 'Fix the bug.' },
        ],
      })
    ).toEqual({
      system_prompt_prefix: 'You are Kilo Code.\nFollow the repository instructions.',
      system_prompt_length: 54,
      user_prompt_prefix: 'Fix the bug.',
    });
  });

  test('combines top-level instructions with input message instructions', () => {
    expect(
      extractResponsesPromptInfo({
        model: 'openai/gpt-5.4',
        instructions: 'Use concise language.',
        input: [
          { role: 'developer', content: 'Return plain text.' },
          { role: 'user', content: 'Summarize this.' },
        ],
      })
    ).toEqual({
      system_prompt_prefix: 'Use concise language.\nReturn plain text.',
      system_prompt_length: 40,
      user_prompt_prefix: 'Summarize this.',
    });
  });

  test('ignores malformed input while preserving valid text', () => {
    const body = {
      model: 'openai/gpt-5.4',
      input: [
        null,
        'invalid item',
        { role: 1, content: 'invalid role' },
        {
          role: 'system',
          content: [
            null,
            { type: 'input_text' },
            { type: 'input_text', text: 'Valid system prompt.' },
          ],
        },
        { role: 'user', content: [{ type: 'input_text', text: 'Valid user prompt.' }] },
      ],
    } as GatewayResponsesRequest;

    expect(extractResponsesPromptInfo(body)).toEqual({
      system_prompt_prefix: 'Valid system prompt.',
      system_prompt_length: 20,
      user_prompt_prefix: 'Valid user prompt.',
    });

    expect(
      extractResponsesPromptInfo({
        model: 'openai/gpt-5.4',
        input: { invalid: true },
      } as unknown as GatewayResponsesRequest)
    ).toEqual({
      system_prompt_prefix: '',
      system_prompt_length: 0,
      user_prompt_prefix: '',
    });
  });
});

describe('processResponsesApiUsage', () => {
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
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      cost: 0.001,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.7 },
    };

    const result = processResponsesApiUsage(usage, null, coreProps);

    expect(result.cost_mUsd).toBe(1000);
    expect(result.is_byok).toBe(false);
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(100);
    expect(result.cacheHitTokens).toBe(10);
    expect(result.cacheWriteTokens).toBe(0);
  });

  test('correctly processes OpenRouter usage for a byok case', () => {
    const usage = {
      input_tokens: 50,
      output_tokens: 100,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      cost: 0.001,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.02 },
    };

    const result = processResponsesApiUsage(usage, null, coreProps);

    expect(result.cost_mUsd).toBe(20000);
    expect(result.is_byok).toBe(true);
  });

  test('correctly processes Vercel usage with cache writes included in input tokens', () => {
    const usage = {
      input_tokens: 15377,
      output_tokens: 6,
      total_tokens: 15383,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 15374 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const providerMetadata = {
      gateway: { routing: { finalProvider: 'openai' }, cost: '0', marketCost: '0.0962825' },
    };

    const result = processResponsesApiUsage(usage, providerMetadata, coreProps);

    expect(result.cost_mUsd).toBe(96283); // toMicrodollars(0.0962825)
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(15377);
    expect(result.outputTokens).toBe(6);
    expect(result.cacheWriteTokens).toBe(15374);
    expect(result.inputTokens - result.cacheWriteTokens).toBe(3);
  });

  test('returns zero cost when no usage or metadata is provided', () => {
    const result = processResponsesApiUsage(null, null, coreProps);

    expect(result.cost_mUsd).toBe(0);
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test('extracts is_byok=true from Vercel modelAttempts credentialType', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const providerMetadata = {
      gateway: {
        routing: {
          finalProvider: 'openai',
          modelAttempts: [
            {
              success: true,
              providerAttempts: [{ provider: 'openai', credentialType: 'byok', success: true }],
            },
          ],
        },
        cost: '0',
        marketCost: '0.0001',
      },
    };

    const result = processResponsesApiUsage(usage, providerMetadata, coreProps);

    expect(result.is_byok).toBe(true);
    expect(result.cost_mUsd).toBe(100);
  });
});

describe('parseMicrodollarUsageFromStream approval tests', () => {
  const openrouterResponses = 'openrouter-responses.log.resp.sse';
  test(openrouterResponses, async () => {
    const inputFile = join(sampleDir, openrouterResponses);
    const nodeStream = createReadStream(inputFile);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const result = await parseResponsesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'openrouter',
      200
    );
    const resultString = JSON.stringify(
      result,
      (key, value) => (key === 'hasFinalTokenUsage' || key === 'hasFinalCost' ? undefined : value),
      2
    );
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  const vercelResponses = 'vercel-responses.log.resp.sse';
  test(vercelResponses, async () => {
    const inputFile = join(sampleDir, vercelResponses);
    const nodeStream = createReadStream(inputFile);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const result = await parseResponsesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'vercel',
      200
    );
    const resultString = JSON.stringify(
      result,
      (key, value) => (key === 'hasFinalTokenUsage' || key === 'hasFinalCost' ? undefined : value),
      2
    );
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  test('handles ResponseAborted error gracefully and returns partial data', async () => {
    const partialSSEData =
      'data: {"type":"response.output_text.delta","delta":"Hello","item_id":"msg_1","output_index":0,"content_index":0,"sequence_number":1,"logprobs":[]}\n\n' +
      'data: {"type":"response.output_text.delta","delta":" world","item_id":"msg_1","output_index":0,"content_index":0,"sequence_number":2,"logprobs":[]}\n\n';

    const responseAbortedError = new Error('Response aborted');
    responseAbortedError.name = 'ResponseAborted';

    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode(partialSSEData));
        } else {
          controller.error(responseAbortedError);
        }
      },
    });

    const result = await parseResponsesMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'openrouter',
      200
    );

    expect(result.responseContent).toBe('Hello world');
    expect(result.hasError).toBe(true);
  });
});

describe('parseMicrodollarUsageFromString approval tests', () => {
  const openrouterResponsesJson = 'openrouter-responses.log.resp.json';
  test(openrouterResponsesJson, async () => {
    const inputFile = join(sampleDir, openrouterResponsesJson);
    const jsonString = await readFile(inputFile, 'utf-8');
    const result = parseResponsesMicrodollarUsageFromString(jsonString, 200);
    const resultString = JSON.stringify(
      result,
      (key, value) => (key === 'hasFinalTokenUsage' || key === 'hasFinalCost' ? undefined : value),
      2
    );
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  const vercelResponsesJson = 'vercel-responses.log.resp.json';
  test(vercelResponsesJson, async () => {
    const inputFile = join(sampleDir, vercelResponsesJson);
    const jsonString = await readFile(inputFile, 'utf-8');
    const result = parseResponsesMicrodollarUsageFromString(jsonString, 200);
    const resultString = JSON.stringify(
      result,
      (key, value) => (key === 'hasFinalTokenUsage' || key === 'hasFinalCost' ? undefined : value),
      2
    );
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});

describe('authoritative Responses usage evidence', () => {
  function stream(type: string, usage?: object): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: ' +
              JSON.stringify({
                type,
                response: {
                  id: 'response',
                  model: 'model',
                  status: type.slice('response.'.length),
                  usage,
                },
              }) +
              '\n\n'
          )
        );
        controller.close();
      },
    });
  }

  test('does not promote in-progress counters or positive costs into a final charge', async () => {
    const stats = await parseResponsesMicrodollarUsageFromStream(
      stream('response.in_progress', {
        input_tokens: 10,
        output_tokens: 5,
        cost: 0.01,
      }),
      'user',
      undefined,
      'martian',
      200
    );
    expect(stats).toMatchObject({
      cost_mUsd: 10000,
      hasFinalTokenUsage: false,
      hasFinalCost: false,
    });
  });

  test.each(['response.completed', 'response.incomplete', 'response.failed'])(
    'accepts authoritative terminal usage from %s',
    async type => {
      const stats = await parseResponsesMicrodollarUsageFromStream(
        stream(type, {
          input_tokens: 0,
          output_tokens: 0,
          cost: 0,
        }),
        'user',
        undefined,
        'openrouter',
        200
      );
      expect(stats).toMatchObject({ hasFinalTokenUsage: true, hasFinalCost: true });
    }
  );

  test('does not synthesize a final zero for a terminal event missing usage', async () => {
    const stats = await parseResponsesMicrodollarUsageFromStream(
      stream('response.completed'),
      'user',
      undefined,
      'martian',
      200
    );
    expect(stats).toMatchObject({ hasFinalTokenUsage: false, hasFinalCost: false });
  });

  test('requires usage on the complete nonstream response, not HTTP success alone', () => {
    const stats = parseResponsesMicrodollarUsageFromString(
      JSON.stringify({
        id: 'response',
        model: 'model',
        status: 'completed',
        output: [],
      }),
      200
    );
    expect(stats).toMatchObject({ hasFinalTokenUsage: false, hasFinalCost: false });
  });
});

test('does not reuse early Responses gateway cost metadata as a final charge', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.in_progress","response":{"id":"response","model":"model","status":"in_progress","usage":{"input_tokens":10,"output_tokens":0},"provider_metadata":{"gateway":{"marketCost":"0"}}}}\n\n' +
            'data: {"type":"response.completed","response":{"id":"response","model":"model","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
        )
      );
      controller.close();
    },
  });
  const stats = await parseResponsesMicrodollarUsageFromStream(
    stream,
    'user',
    undefined,
    'vercel',
    200
  );
  expect(stats).toMatchObject({ hasFinalTokenUsage: true, hasFinalCost: false });
});
