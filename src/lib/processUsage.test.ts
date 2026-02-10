import { test, describe, expect } from '@jest/globals';
import type { MicrodollarUsageStats, MicrodollarUsageContext } from './processUsage';
import {
  extractPromptInfo,
  parseMicrodollarUsageFromStream,
  parseMicrodollarUsageFromString,
  mapToUsageStats,
  logMicrodollarUsage,
  processOpenRouterUsage,
} from './processUsage';
import type { OpenRouterGeneration } from '@/lib/providers/openrouter/types';
import { verifyApproval } from '../tests/helpers/approval.helper';
import { insertTestUser } from '../tests/helpers/user.helper';
import { insertUsageWithOverrides } from '../tests/helpers/microdollar-usage.helper';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { db } from '@/lib/drizzle';
import { microdollar_usage, microdollar_usage_metadata } from '@/db/schema';
import { eq, getTableColumns } from 'drizzle-orm';
import { findUserById } from './user';
import { Readable } from 'node:stream';
import { getFraudDetectionHeaders, toMicrodollars } from './utils';

// Note: Legacy banned_ja4/whitelist_ja4 tests removed - abuse classification
// is now handled by the external abuse detection service (src/lib/abuse-service.ts)

describe('processOpenRouterUsage', () => {
  const coreProps = {
    messageId: 'test-message-id',
    model: 'test-model',
    responseContent: 'test-response',
    hasError: false,
    kiloUserId: 'test-user-id',
    inference_provider: 'Provider',
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
  };

  test('should correctly process usage for a non-byok case', () => {
    const usage = {
      cost: 0.001,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.7 },
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens: 50,
      prompt_tokens_details: { cached_tokens: 0 },
      total_tokens: 150,
    };

    const result = processOpenRouterUsage(usage, coreProps);

    expect(result.cost_mUsd).toBe(1000);
    expect(result.is_byok).toBe(false);
  });

  test('should correctly process usage for a byok case', () => {
    const usage = {
      is_byok: true,
      cost: 0.001,
      cost_details: { upstream_inference_cost: 0.02 },
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens: 50,
      prompt_tokens_details: { cached_tokens: 0 },
      total_tokens: 150,
    };

    const result = processOpenRouterUsage(usage, coreProps);

    expect(result.cost_mUsd).toBe(20000);
    expect(result.is_byok).toBe(true);
  });
});

const sampleDir = join(process.cwd(), 'src/tests/sample');
describe('parseMicrodollarUsageFromStream approval tests', () => {
  const normalAnthropic = 'normal-anthropic.log.resp.sse';
  test(normalAnthropic, async () => {
    const inputFile = join(sampleDir, normalAnthropic);
    const nodeStream = createReadStream(inputFile);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const result = await parseMicrodollarUsageFromStream(
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

  const normalGpt41 = 'normal-gpt41.log.resp.sse';
  test(normalGpt41, async () => {
    const inputFile = join(sampleDir, normalGpt41);
    const nodeStream = createReadStream(inputFile);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const result = await parseMicrodollarUsageFromStream(
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

  const outOfCredits = 'openrouter-key-out-of-credits.log.resp.sse';
  test(outOfCredits, async () => {
    const inputFile = join(sampleDir, outOfCredits);
    const nodeStream = createReadStream(inputFile);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const result = await parseMicrodollarUsageFromStream(
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

  const nonStreaming = 'nonstreaming-anthropic.log.resp.json';
  test(nonStreaming, async () => {
    const inputFile = join(sampleDir, nonStreaming);
    const jsonString = await readFile(inputFile, 'utf-8');
    const result = parseMicrodollarUsageFromString(jsonString, 'fake-user-id', 200);
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  test('handles ResponseAborted error gracefully and returns partial data', async () => {
    // Create a stream that emits some SSE data then throws ResponseAborted
    const partialSSEData = `data: {"id":"gen-123","model":"anthropic/claude-3-5-sonnet","choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"id":"gen-123","model":"anthropic/claude-3-5-sonnet","choices":[{"delta":{"content":" world"}}]}\n\n`;

    // Create a custom error that mimics ResponseAborted
    const responseAbortedError = new Error('Response aborted');
    responseAbortedError.name = 'ResponseAborted';

    let pullCount = 0;
    // Create a readable stream that emits partial data then throws on second pull
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode(partialSSEData));
        } else {
          // Simulate abort on subsequent read
          controller.error(responseAbortedError);
        }
      },
    });

    const result = await parseMicrodollarUsageFromStream(
      stream,
      'fake-user-id',
      undefined,
      'openrouter',
      200
    );

    // Should have captured partial data before abort
    expect(result.messageId).toBe('gen-123');
    expect(result.model).toBe('anthropic/claude-3-5-sonnet');
    expect(result.responseContent).toBe('Hello world');
    expect(result.hasError).toBe(true); // Should be marked as error due to abort
  });
});

const sampleReqDir = join(process.cwd(), 'src/tests/req_sample');
describe('extractPromptInfo approval tests', () => {
  const anthropicFile = 'anthropic-claude37.log.req.json';
  test(anthropicFile, async () => {
    const inputFile = join(sampleReqDir, anthropicFile);
    const prompt = await readFile(inputFile, 'utf-8');
    const result = extractPromptInfo(JSON.parse(prompt));
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.extractPromptInfo.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  const geminiFile = 'google-gemini25.log.req.json';
  test(geminiFile, async () => {
    const inputFile = join(sampleReqDir, geminiFile);
    const prompt = await readFile(inputFile, 'utf-8');
    const result = extractPromptInfo(JSON.parse(prompt));
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.extractPromptInfo.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });

  const openAiGptFile = 'openai-gpt41.log.req.json';
  test(openAiGptFile, async () => {
    const inputFile = join(sampleReqDir, openAiGptFile);
    const prompt = await readFile(inputFile, 'utf-8');
    const result = extractPromptInfo(JSON.parse(prompt));
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.extractPromptInfo.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});

describe('mapToUsageStats approval tests', () => {
  const claudeSonnetGeneration = 'claude-3-7-sonnet-generation.log.generation.json';
  test(claudeSonnetGeneration, async () => {
    const inputFile = join(sampleDir, claudeSonnetGeneration);
    const generationData = JSON.parse(await readFile(inputFile, 'utf-8')) as OpenRouterGeneration;
    const result = mapToUsageStats(generationData, 'nonsense', 'fake-user-id');
    const resultString = JSON.stringify(result, null, 2);
    const approvalFilePath = inputFile + '.mapToUsageStats.approved.json';
    await verifyApproval(resultString, approvalFilePath);
  });
});

describe('toMicrodollars', () => {
  test('converts dollar amount to microdollars', () => {
    expect(toMicrodollars(0.123456)).toBe(123456);
    expect(toMicrodollars(1)).toBe(1000000);
    expect(toMicrodollars(0)).toBe(0);
    expect(toMicrodollars(0.00000099)).toBe(1); // 0.00000099 * 1000000 = 0.99, round to 1
    expect(toMicrodollars(0.1234567)).toBe(123457); // 0.1234567 * 1000000 = 123456.7, round to 123457
    expect(toMicrodollars(0.0849 / 20)).toBe(4245); // float accuracy: 4245.000000000001 should round to 4245.
  });
});

describe('mapToUsageStats', () => {
  test('applies BYOK multiplier when is_byok is true', () => {
    // Create a sample OpenRouterGeneration with is_byok set to true
    const byokGeneration: OpenRouterGeneration = {
      data: {
        id: 'test-byok-id',
        total_cost: 0.1,
        upstream_inference_cost: 2.0, // Example cost for BYOK
        is_byok: true,
        created_at: '2025-05-14T00:00:00Z',
        model: 'test-model',
        origin: 'test-origin',
        usage: 0.1,
        native_tokens_prompt: 100,
        native_tokens_completion: 50,
        native_tokens_cached: 0,
      },
    };

    // Call mapToUsageStats with the BYOK generation
    const result = mapToUsageStats(byokGeneration, 'test response', 'fake-user-id');

    // Verify that the cost is multiplied by OPENROUTER_BYOK_COST_MULTIPLIER
    expect(result.cost_mUsd).toBe(toMicrodollars(0.1 * 20.0)); // 0.1 * 20 = 2, then convert to microdollars
  });

  test('does not apply BYOK multiplier when is_byok is false', () => {
    // Create a sample OpenRouterGeneration with is_byok set to false
    const nonByokGeneration: OpenRouterGeneration = {
      data: {
        id: 'test-non-byok-id',
        total_cost: 0.1,
        created_at: '2025-05-14T00:00:00Z',
        model: 'test-model',
        origin: 'test-origin',
        usage: 0.1,
        is_byok: false,
        native_tokens_prompt: 100,
        native_tokens_completion: 50,
        native_tokens_cached: 0,
      },
    };

    // Call mapToUsageStats with the non-BYOK generation
    const result = mapToUsageStats(nonByokGeneration, 'test response', ' fake-user-id');

    // Verify that the cost is not multiplied
    expect(result.cost_mUsd).toBe(toMicrodollars(0.1)); // Just convert to microdollars without multiplier
  });
});

describe('logMicrodollarUsage', () => {
  const BASE_USAGE_STATS: MicrodollarUsageStats = {
    messageId: 'test-msg-123',
    hasError: false,
    cost_mUsd: 500,
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 10,
    cacheHitTokens: 5,
    is_byok: true,
    model: 'anthropic/claude-3.7-sonnet',
    responseContent: 'Test response content',
    inference_provider: 'Provider',
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
  };
  const createBaseUsageContext = (user: {
    id: string;
    microdollars_used: number;
    google_user_email: string | null;
  }) =>
    ({
      kiloUserId: user.id,
      prior_microdollar_usage: user.microdollars_used,
      posthog_distinct_id: user.google_user_email!,
      provider: 'openrouter',
      fraudHeaders: getFraudDetectionHeaders(new Headers({ 'user-agent': 'test-agent' })),
      isStreaming: true,
      project_id: null,
      requested_model: 'anthropic/claude-3.7-sonnet',
      promptInfo: {
        system_prompt_prefix: 'You are a helpful assistant',
        system_prompt_length: 'You are a helpful assistant'.length,
        user_prompt_prefix: 'Please help me with',
      },
      max_tokens: 200,
      has_middle_out_transform: true,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      status_code: 200,
      editor_name: null,
      machine_id: null,
      user_byok: false,
      has_tools: false,
    }) satisfies MicrodollarUsageContext;

  test('stores usage data and increments user microdollars for positive cost', async () => {
    const user = await insertTestUser({
      id: 'test-log-user-1',
      microdollars_used: 1000,
      google_user_email: 'test@example.com',
    });

    const usageStats = BASE_USAGE_STATS;
    const usageContext = createBaseUsageContext(user);

    await logMicrodollarUsage(usageStats, usageContext);

    const updatedUser = await findUserById('test-log-user-1');
    expect(updatedUser?.microdollars_used).toBe(1500); // 1000 + 500

    const metadataRecord = await db.query.microdollar_usage_metadata.findFirst({
      where: eq(microdollar_usage_metadata.message_id, 'test-msg-123'),
    });
    expect(metadataRecord).toBeTruthy();

    const usageRecord = await db.query.microdollar_usage.findFirst({
      where: eq(microdollar_usage.id, metadataRecord!.id),
    });
    expect(usageRecord).toBeTruthy();
    expect(usageRecord?.kilo_user_id).toBe('test-log-user-1');
    expect(usageRecord?.cost).toBe(500);
    expect(usageRecord?.input_tokens).toBe(100);
    expect(usageRecord?.output_tokens).toBe(50);
    expect(usageRecord?.cache_write_tokens).toBe(10);
    expect(usageRecord?.cache_hit_tokens).toBe(5);
    expect(usageRecord?.provider).toBe('openrouter');
    expect(usageRecord?.model).toBe('anthropic/claude-3.7-sonnet');
    expect(metadataRecord?.system_prompt_length).toBe(27);
    expect(metadataRecord?.user_prompt_prefix).toBe('Please help me with');
    expect(metadataRecord?.max_tokens).toBe(200);
    expect(metadataRecord?.has_middle_out_transform).toBe(true);
    expect(usageRecord?.has_error).toBe(false);
    expect(usageRecord?.created_at).toBeTruthy();
    expect(metadataRecord?.created_at).toBe(usageRecord?.created_at);
  });

  test('stores usage data without incrementing user microdollars for zero cost', async () => {
    const user = await insertTestUser({
      id: 'test-log-user-2',
      microdollars_used: 2000,
      google_user_email: 'test2@example.com',
    });

    const usageStats: MicrodollarUsageStats = {
      ...BASE_USAGE_STATS,
      messageId: 'test-msg-456',
      hasError: true,
      cost_mUsd: 0, // Zero cost
      model: 'openai/gpt-4.1',
    };

    const usageContext: MicrodollarUsageContext = {
      ...createBaseUsageContext(user),
      requested_model: 'openai/gpt-4.1',
      isStreaming: false,
      has_middle_out_transform: false,
      promptInfo: {
        system_prompt_prefix: '',
        system_prompt_length: 0,
        user_prompt_prefix: 'error test',
      },
    };

    await logMicrodollarUsage(usageStats, usageContext);

    // Verify user microdollars were NOT incremented
    const updatedUser = await findUserById('test-log-user-2');
    expect(updatedUser?.microdollars_used).toBe(2000); // unchanged

    const metadataRecord = await db.query.microdollar_usage_metadata.findFirst({
      where: eq(microdollar_usage_metadata.message_id, 'test-msg-456'),
    });
    expect(metadataRecord).toBeTruthy();

    const usageRecord = await db.query.microdollar_usage.findFirst({
      where: eq(microdollar_usage.id, metadataRecord!.id),
    });
    expect(usageRecord).toBeTruthy();
    expect(usageRecord?.kilo_user_id).toBe('test-log-user-2');
    expect(usageRecord?.cost).toBe(0);
    expect(usageRecord?.has_error).toBe(true);
    expect(usageRecord?.model).toBe('openai/gpt-4.1');
    expect(metadataRecord?.has_middle_out_transform).toBe(false);
  });

  test('stores 3 usage records with overlapping data and tests metadata deduplication', async () => {
    const user = await insertTestUser({
      id: 'test-dedup-user',
      microdollars_used: 3000,
      google_user_email: 'dedup@example.com',
    });

    // Record 1: baseline data
    const usageStats1 = { ...BASE_USAGE_STATS, messageId: 'dedup-msg-1', cost_mUsd: 300 };
    const baseContext1 = createBaseUsageContext(user);
    const req1headers = {
      'user-agent': 'test-agent-1',
      'x-forwarded-for': '192.168.1.1',
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-city': 'NYC',
      'x-vercel-ja4-digest': 'digest1',
    };
    const usageContext1: MicrodollarUsageContext = {
      ...baseContext1,
      fraudHeaders: getFraudDetectionHeaders(new Headers(req1headers)),
      promptInfo: {
        system_prompt_prefix: 'You are helpful',
        system_prompt_length: 'You are helpful'.length,
        user_prompt_prefix: 'Test message',
      },
    };

    // Record 2: overlapping IP, country, ja4, and system prompt with record 1
    const usageStats2 = { ...BASE_USAGE_STATS, messageId: 'dedup-msg-2', cost_mUsd: 400 };
    const baseContext2 = createBaseUsageContext(user);
    const usageContext2: MicrodollarUsageContext = {
      ...baseContext2,
      fraudHeaders: getFraudDetectionHeaders(
        new Headers({
          ...req1headers,
          'user-agent': 'test-agent-2',
          'x-vercel-ip-city': 'LA',
        })
      ),
      promptInfo: {
        system_prompt_prefix: 'You are helpful', // same system prompt as record 1
        system_prompt_length: 'You are helpful'.length,
        user_prompt_prefix: 'Test message',
      },
    };

    // Record 3: overlapping user-agent and city with record 1, different others
    const usageStats3 = { ...BASE_USAGE_STATS, messageId: 'dedup-msg-3', cost_mUsd: 500 };
    const baseContext3 = createBaseUsageContext(user);
    const usageContext3: MicrodollarUsageContext = {
      ...baseContext3,
      fraudHeaders: getFraudDetectionHeaders(
        new Headers({
          ...req1headers,
          'x-forwarded-for': '192.168.1.2',
          'x-vercel-ip-country': 'CA',
          'x-vercel-ja4-digest': 'digest2',
        })
      ),
      promptInfo: {
        system_prompt_prefix: 'You are an assistant', // different system prompt
        system_prompt_length: 'You are an assistant'.length,
        user_prompt_prefix: 'Test message',
      },
    };

    await logMicrodollarUsage(usageStats1, usageContext1);
    await logMicrodollarUsage(usageStats2, usageContext2);
    await logMicrodollarUsage(usageStats3, usageContext3);

    const updatedUser = await findUserById('test-dedup-user');
    expect(updatedUser?.microdollars_used).toBe(4200); // 3000 + 300 + 400 + 500

    // Verify all 3 usage records exist
    const usageRecords = await db.query.microdollar_usage.findMany({
      where: eq(microdollar_usage.kilo_user_id, 'test-dedup-user'),
    });
    expect(usageRecords).toHaveLength(3);

    const relevantMetadata = await db
      .select(getTableColumns(microdollar_usage_metadata))
      .from(microdollar_usage_metadata)
      .innerJoin(microdollar_usage, eq(microdollar_usage_metadata.id, microdollar_usage.id))
      .where(eq(microdollar_usage.kilo_user_id, 'test-dedup-user'))
      .orderBy(microdollar_usage_metadata.message_id);

    // If we get here, the tables exist and we can test deduplication
    expect(relevantMetadata).toHaveLength(3);

    // Test deduplication by checking that shared values have the same IDs
    const metadata1 = relevantMetadata.find(r => r.message_id === 'dedup-msg-1')!;
    const metadata2 = relevantMetadata.find(r => r.message_id === 'dedup-msg-2')!;
    const metadata3 = relevantMetadata.find(r => r.message_id === 'dedup-msg-3')!;

    // Records 1 and 3 should share the same user-agent ID (both use 'test-agent-1')
    expect(metadata1.http_user_agent_id).toBe(metadata3.http_user_agent_id);
    expect(metadata1.http_user_agent_id).not.toBe(metadata2.http_user_agent_id);

    // Records 1 and 2 should share the same IP ID (both use '192.168.1.1')
    expect(metadata1.http_ip_id).toBe(metadata2.http_ip_id);
    expect(metadata1.http_ip_id).not.toBe(metadata3.http_ip_id);

    // Records 1 and 2 should share the same country ID (both use 'US')
    expect(metadata1.vercel_ip_country_id).toBe(metadata2.vercel_ip_country_id);
    expect(metadata1.vercel_ip_country_id).not.toBe(metadata3.vercel_ip_country_id);

    // Records 1 and 3 should share the same city ID (both use 'NYC')
    expect(metadata1.vercel_ip_city_id).toBe(metadata3.vercel_ip_city_id);
    expect(metadata1.vercel_ip_city_id).not.toBe(metadata2.vercel_ip_city_id);

    // Records 1 and 2 should share the same ja4 ID (both use 'digest1')
    expect(metadata1.ja4_digest_id).toBe(metadata2.ja4_digest_id);
    expect(metadata1.ja4_digest_id).not.toBe(metadata3.ja4_digest_id);

    // Records 1 and 2 should share the same system prompt prefix ID (both use 'You are helpful')
    expect(metadata1.system_prompt_prefix_id).toBe(metadata2.system_prompt_prefix_id);
    expect(metadata1.system_prompt_prefix_id).not.toBe(metadata3.system_prompt_prefix_id);

    // All records should have their expected non-shared metadata
    expect(metadata1.max_tokens).toBe(200);
    expect(metadata2.max_tokens).toBe(200);
    expect(metadata3.max_tokens).toBe(200);
    expect(metadata1.has_middle_out_transform).toBe(true);
    expect(metadata2.has_middle_out_transform).toBe(true);
    expect(metadata3.has_middle_out_transform).toBe(true);
  });

  test('nullifies sensitive data for organization usage (data minimization)', async () => {
    const user = await insertTestUser({
      id: 'test-org-user-1',
      microdollars_used: 500,
      google_user_email: 'orguser@example.com',
    });

    const usageStats: MicrodollarUsageStats = {
      ...BASE_USAGE_STATS,
      messageId: 'test-org-msg-123',
    };

    const usageContext: MicrodollarUsageContext = {
      ...createBaseUsageContext(user),
      organizationId: '12345678-1234-1234-1234-123456789abc', // This triggers data minimization
    };

    await logMicrodollarUsage(usageStats, usageContext);

    const metadataRecord = await db.query.microdollar_usage_metadata.findFirst({
      where: eq(microdollar_usage_metadata.message_id, 'test-org-msg-123'),
    });

    expect(metadataRecord).toBeTruthy();

    const usageRecord = await db.query.microdollar_usage.findFirst({
      where: eq(microdollar_usage.id, metadataRecord!.id),
    });

    expect(usageRecord).toBeTruthy();
    expect(usageRecord?.kilo_user_id).toBe('test-org-user-1');
    expect(usageRecord?.organization_id).toBe('12345678-1234-1234-1234-123456789abc');
    expect(usageRecord?.cost).toBe(500);

    // Verify data minimization: sensitive prompt data should be null for organizations
    expect(metadataRecord?.user_prompt_prefix).toBe(null);
    expect(metadataRecord?.system_prompt_prefix_id).toBe(null);

    // Other fields should still be populated normally
    expect(usageRecord?.input_tokens).toBe(100);
    expect(usageRecord?.output_tokens).toBe(50);
    expect(usageRecord?.model).toBe('anthropic/claude-3.7-sonnet');
    expect(usageRecord?.provider).toBe('openrouter');
  });

  test('insertUsageRecord updates user balance atomically via insertUsageWithOverrides', async () => {
    const user = await insertTestUser({
      id: 'test-insert-balance-user',
      microdollars_used: 5000,
      google_user_email: 'insertbalance@example.com',
    });

    // Insert usage record directly via insertUsageWithOverrides (which calls insertUsageRecord)
    await insertUsageWithOverrides({
      kilo_user_id: user.id,
      cost: 2500,
    });

    // Verify user balance was updated
    const updatedUser = await findUserById('test-insert-balance-user');
    expect(updatedUser?.microdollars_used).toBe(7500); // 5000 + 2500

    // Insert another usage record
    await insertUsageWithOverrides({
      kilo_user_id: user.id,
      cost: 1000,
    });

    // Verify balance accumulated correctly
    const finalUser = await findUserById('test-insert-balance-user');
    expect(finalUser?.microdollars_used).toBe(8500); // 7500 + 1000
  });

  test('insertUsageRecord does not update balance for zero cost via insertUsageWithOverrides', async () => {
    const user = await insertTestUser({
      id: 'test-insert-zero-cost-user',
      microdollars_used: 3000,
      google_user_email: 'insertzero@example.com',
    });

    // Insert usage record with zero cost
    await insertUsageWithOverrides({
      kilo_user_id: user.id,
      cost: 0,
    });

    // Verify user balance was NOT updated
    const updatedUser = await findUserById('test-insert-zero-cost-user');
    expect(updatedUser?.microdollars_used).toBe(3000); // unchanged
  });

  test('insertUsageRecord does not update user balance for organization usage via insertUsageWithOverrides', async () => {
    const user = await insertTestUser({
      id: 'test-insert-org-user',
      microdollars_used: 4000,
      google_user_email: 'insertorg@example.com',
    });

    // Insert usage record with organization_id (should not update user balance)
    await insertUsageWithOverrides({
      kilo_user_id: user.id,
      organization_id: '12345678-1234-1234-1234-123456789abc',
      cost: 2000,
    });

    // Verify user balance was NOT updated (org usage doesn't deplete user balance)
    const updatedUser = await findUserById('test-insert-org-user');
    expect(updatedUser?.microdollars_used).toBe(4000); // unchanged
  });
});
