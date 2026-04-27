import { test, describe, expect } from '@jest/globals';
import {
  parseResponsesMicrodollarUsageFromStream,
  parseResponsesMicrodollarUsageFromString,
  processResponsesApiUsage,
} from './processUsage.responses';
import { verifyApproval } from '../../tests/helpers/approval.helper';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

const sampleDir = join(process.cwd(), 'src/tests/sample');

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
      input_tokens_details: { cached_tokens: 10 },
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
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      cost: 0.001,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.02 },
    };

    const result = processResponsesApiUsage(usage, null, coreProps);

    expect(result.cost_mUsd).toBe(20000);
    expect(result.is_byok).toBe(true);
  });

  test('correctly processes Vercel usage with marketCost', () => {
    const usage = {
      input_tokens: 2425,
      output_tokens: 5,
      total_tokens: 2430,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const providerMetadata = {
      gateway: { routing: { finalProvider: 'openai' }, cost: '0', marketCost: '0.0061375' },
    };

    const result = processResponsesApiUsage(usage, providerMetadata, coreProps);

    expect(result.cost_mUsd).toBe(6138); // toMicrodollars(0.0061375)
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(2425);
    expect(result.outputTokens).toBe(5);
  });

  test('returns zero cost when no usage or metadata is provided', () => {
    const result = processResponsesApiUsage(null, null, coreProps);

    expect(result.cost_mUsd).toBe(0);
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
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
    const resultString = JSON.stringify(result, null, 2);
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
    const resultString = JSON.stringify(result, null, 2);
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
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  const vercelResponsesJson = 'vercel-responses.log.resp.json';
  test(vercelResponsesJson, async () => {
    const inputFile = join(sampleDir, vercelResponsesJson);
    const jsonString = await readFile(inputFile, 'utf-8');
    const result = parseResponsesMicrodollarUsageFromString(jsonString, 200);
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});
