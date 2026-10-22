import { beforeEach, describe, expect, test } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import { eq } from 'drizzle-orm';
import type { StoredModel } from '@kilocode/db';
import { microdollar_usage } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { countAndStoreUsage } from './processUsage';
import { estimateUnparseableResponseUsage } from './processUsage.estimate';
import type { MicrodollarUsageContext } from './processUsage.types';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureMessage: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));

const MODEL = 'vendor/paid-model';

function usageContext(overrides: Partial<MicrodollarUsageContext> = {}): MicrodollarUsageContext {
  return {
    api_kind: 'chat_completions',
    kiloUserId: 'user-1',
    prior_microdollar_usage: 0,
    provider: 'openrouter',
    fraudHeaders: getFraudDetectionHeaders(new Headers({ 'user-agent': 'test-agent' })),
    isStreaming: false,
    project_id: null,
    requested_model: MODEL,
    is_free: false,
    promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
    max_tokens: null,
    estimated_input_tokens: 1000,
    has_middle_out_transform: null,
    status_code: 200,
    editor_name: null,
    machine_id: null,
    user_byok: false,
    has_tools: false,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    reasoning_setting: null,
    ttfb_ms: null,
    ...overrides,
  };
}

// 400 bytes, so 100 estimated output tokens.
const SSE_BODY = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'x'.repeat(341) } }] })}\n\n`;

beforeEach(() => {
  jest.mocked(captureMessage).mockClear();
  // $1 per million input tokens, $2 per million output tokens; a pricier route
  // sets the estimate.
  jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
    [MODEL]: {
      id: MODEL,
      name: 'Paid model',
      endpoints: [
        { pricing: { prompt: '0.0000005', completion: '0.000001' } },
        { pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    } satisfies StoredModel,
    '~vendor/alias': {
      id: '~vendor/alias',
      name: 'Paid model alias',
      endpoints: [],
      alias_target: { slug: MODEL },
    } satisfies StoredModel,
  });
});

describe('estimateUnparseableResponseUsage', () => {
  test('charges the estimated input and output tokens at the most expensive route', async () => {
    expect(Buffer.byteLength(SSE_BODY)).toBe(400);

    const usage = await estimateUnparseableResponseUsage(SSE_BODY, usageContext(), 200);

    expect(usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      cost_mUsd: 1200,
      hasError: true,
      messageId: null,
      model: null,
      status_code: 200,
    });
  });

  test('caps the output estimate at max_tokens', async () => {
    const usage = await estimateUnparseableResponseUsage(
      SSE_BODY,
      usageContext({ max_tokens: 10 }),
      200
    );

    expect(usage.outputTokens).toBe(10);
    expect(usage.cost_mUsd).toBe(1020);
  });

  test('prices a model alias at its target', async () => {
    const usage = await estimateUnparseableResponseUsage(
      SSE_BODY,
      usageContext({ requested_model: '~vendor/alias' }),
      200
    );

    expect(usage.cost_mUsd).toBe(1200);
  });

  test('keeps the token estimate without a market cost when the model has no pricing', async () => {
    const usage = await estimateUnparseableResponseUsage(
      SSE_BODY,
      usageContext({ requested_model: 'vendor/unknown-model' }),
      200
    );

    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, cost_mUsd: 0 });
  });

  test('charges nothing for an error response', async () => {
    const usage = await estimateUnparseableResponseUsage(
      '<html>Bad gateway</html>',
      usageContext(),
      502
    );

    expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cost_mUsd: 0, hasError: true });
  });
});

describe('countAndStoreUsage with an unparseable non-streaming response', () => {
  test('records an estimated charge instead of failing', async () => {
    const user = await insertTestUser({ microdollars_used: 0 });

    const result = await countAndStoreUsage(
      new Response(SSE_BODY, { headers: { 'content-type': 'text/event-stream' } }),
      usageContext({ kiloUserId: user.id }),
      undefined
    );

    expect(result).not.toBeNull();
    const [usage] = await db
      .select()
      .from(microdollar_usage)
      .where(eq(microdollar_usage.kilo_user_id, user.id));
    expect(usage).toMatchObject({
      cost: 1200,
      input_tokens: 1000,
      output_tokens: 100,
      has_error: true,
      model: MODEL,
      requested_model: MODEL,
    });
    expect((await findUserById(user.id))?.microdollars_used).toBe(1200);
    expect(captureMessage).toHaveBeenCalledWith(
      'Charged an estimate for a response whose usage could not be parsed',
      expect.objectContaining({
        extra: expect.objectContaining({
          error_name: 'SyntaxError',
          requested_model: MODEL,
          estimated_cost_mUsd: 1200,
        }),
      })
    );
  });

  test('records the estimate at zero cost for a free model', async () => {
    const user = await insertTestUser({ microdollars_used: 0 });

    await countAndStoreUsage(
      new Response(SSE_BODY),
      usageContext({ kiloUserId: user.id, is_free: true }),
      undefined
    );

    const [usage] = await db
      .select()
      .from(microdollar_usage)
      .where(eq(microdollar_usage.kilo_user_id, user.id));
    expect(usage).toMatchObject({ cost: 0, input_tokens: 1000, output_tokens: 100 });
  });
});
