import { test, describe, expect } from '@jest/globals';
import {
  parseMessagesMicrodollarUsageFromStream,
  parseMessagesMicrodollarUsageFromString,
  processMessagesApiUsage,
} from './processUsage.messages';
import { verifyApproval } from '../../tests/helpers/approval.helper';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

const sampleDir = join(process.cwd(), 'src/tests/sample');

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
  };

  test('correctly processes OpenRouter usage for a non-byok case', () => {
    const usage = {
      input_tokens: 50,
      output_tokens: 100,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      server_tool_use: { input_tokens: 0, web_fetch_requests: 0, web_search_requests: 0 },
      cost: 0.001,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.7 },
    };

    const result = processMessagesApiUsage(usage, null, coreProps);

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
      cost: 0.001,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.02 },
    };

    const result = processMessagesApiUsage(usage, null, coreProps);

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
    };
    const providerMetadata = {
      gateway: { routing: { finalProvider: 'anthropic' }, cost: '0', marketCost: '0.000375' },
    };

    const result = processMessagesApiUsage(usage, providerMetadata, coreProps);

    expect(result.cost_mUsd).toBe(375); // toMicrodollars(0.000375)
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(6);
    expect(result.cacheHitTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });

  test('returns zero cost when no usage or metadata is provided', () => {
    const result = processMessagesApiUsage(null, null, coreProps);

    expect(result.cost_mUsd).toBe(0);
    expect(result.is_byok).toBeNull();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe('parseMessagesMicrodollarUsageFromStream approval tests', () => {
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
      200
    );
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});

describe('parseMessagesMicrodollarUsageFromString approval tests', () => {
  const vercelMessagesJson = 'vercel-messages.log.resp.json';
  test(vercelMessagesJson, async () => {
    const inputFile = join(sampleDir, vercelMessagesJson);
    const jsonString = await readFile(inputFile, 'utf-8');
    const result = parseMessagesMicrodollarUsageFromString(jsonString, 200);
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});
