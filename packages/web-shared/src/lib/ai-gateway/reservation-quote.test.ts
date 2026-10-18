import { beforeEach, describe, expect, it } from '@jest/globals';
import type { KiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import type { CustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { getCustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { calculateCustomCost_mUsd } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import { findKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { quoteInferenceReservation } from './reservation-quote';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants', () => ({
  getCustomPricing: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => ({
  findKiloExclusiveModel: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

const fixedPricing: CustomPricing = {
  pricing: [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 1,
        completion_per_million: 2,
        input_cache_read_per_million: 0.1,
        input_cache_write_per_million: 1.25,
      },
    },
    {
      start_context_length: 50,
      pricing: {
        prompt_per_million: 3,
        completion_per_million: 8,
        input_cache_read_per_million: 0.3,
        input_cache_write_per_million: 6,
      },
    },
  ],
};

const exclusive = {
  public_id: 'stealth/model',
  internal_id: 'vendor/model:optimized',
  context_length: 100,
  max_completion_tokens: 40,
  provider: { id: 'martian' },
  pricing: { tiers: fixedPricing.pricing },
} as KiloExclusiveModel;

function textInput(body: Record<string, unknown> = {}): {
  apiKind: string;
  model: string;
  providerId: string;
  body: Record<string, unknown>;
} {
  return {
    apiKind: 'chat_completions',
    model: exclusive.public_id,
    providerId: 'martian',
    body: { model: exclusive.internal_id, messages: [{ role: 'user', content: 'hello' }], ...body },
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(findKiloExclusiveModel).mockReturnValue(exclusive);
  jest.mocked(getCustomPricing).mockReturnValue(undefined);
});

describe('full-input-context fixed billing reservation', () => {
  it('uses every tier and cache-write premium rather than the display or first tier', async () => {
    const input = textInput({
      max_tokens: 1,
      safety_identifier: 'gateway-payer-digest',
      prompt_cache_key: 'gateway-cache-digest',
    });
    expect(await quoteInferenceReservation(input)).toEqual({
      kind: 'quoted',
      amountMicrodollars: 608,
    });
    expect(input.body.max_tokens).toBe(1);
  });

  it('holds a whole input context but only the requested total output including reasoning', async () => {
    const small = textInput({ reasoning: { max_tokens: 80 }, max_tokens: 1 });
    const large = textInput({
      messages: [{ role: 'user', content: '😀'.repeat(10000) }],
      max_tokens: 1,
    });
    expect(await quoteInferenceReservation(small)).toEqual(await quoteInferenceReservation(large));
    expect(await quoteInferenceReservation(small)).toEqual({
      kind: 'quoted',
      amountMicrodollars: 608,
    });
  });

  it.each([
    ['chat_completions', 'max_completion_tokens'],
    ['messages', 'max_tokens'],
    ['responses', 'max_output_tokens'],
  ])('adds a finite output cap for %s', async (apiKind, field) => {
    const input = { ...textInput(), apiKind };
    expect((await quoteInferenceReservation(input)).kind).toBe('quoted');
    expect(input.body[field]).toBe(40);
  });

  it('clamps all provided output caps after final provider transformations', async () => {
    const input = textInput({
      max_tokens: 1000,
      max_completion_tokens: 2000,
      max_output_tokens: 3000,
    });
    expect((await quoteInferenceReservation(input)).kind).toBe('quoted');
    expect(input.body).toMatchObject({
      max_tokens: 40,
      max_completion_tokens: 40,
      max_output_tokens: 40,
    });
  });

  it('does not reserve a full output context for a large-context small-output request', async () => {
    jest
      .mocked(findKiloExclusiveModel)
      .mockReturnValue({ ...exclusive, context_length: 1_000_000 });
    expect(await quoteInferenceReservation(textInput({ max_tokens: 1 }))).toEqual({
      kind: 'quoted',
      amountMicrodollars: 6_000_008,
    });
  });

  it('preserves the smallest explicit output cap across aliases', async () => {
    const input = textInput({ max_tokens: 3, max_completion_tokens: 30 });
    expect(await quoteInferenceReservation(input)).toEqual({
      kind: 'quoted',
      amountMicrodollars: 624,
    });
    expect(input.body).toMatchObject({ max_tokens: 3, max_completion_tokens: 3 });
  });

  it.each([
    { context_length: 0 },
    { context_length: Number.POSITIVE_INFINITY },
    { max_completion_tokens: 0 },
    { max_completion_tokens: Number.NaN },
  ])('rejects a missing or invalid declared model ceiling %s', async ceiling => {
    jest.mocked(findKiloExclusiveModel).mockReturnValue({ ...exclusive, ...ceiling });
    expect((await quoteInferenceReservation(textInput())).kind).toBe('unsupported');
  });

  it('refuses unsupported multiple sampling before reserving a provider request', async () => {
    expect((await quoteInferenceReservation(textInput({ n: 3, best_of: 5 }))).kind).toBe(
      'unsupported'
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid output cap %s',
    async max_tokens => {
      expect(await quoteInferenceReservation(textInput({ max_tokens }))).toEqual({
        kind: 'unsupported',
        reason: 'invalid_output_token_limit',
      });
    }
  );

  it.each([
    { n: 0 },
    { n: -1 },
    { n: 1.5 },
    { n: 3, best_of: 2 },
    { best_of: Number.POSITIVE_INFINITY },
  ])('rejects invalid sampling %s', async body => {
    expect(await quoteInferenceReservation(textInput(body))).toEqual({
      kind: 'unsupported',
      reason: 'invalid_sample_count',
    });
  });

  it('rejects integer overflow rather than rounding a falsely precise ceiling', async () => {
    jest.mocked(findKiloExclusiveModel).mockReturnValue({
      ...exclusive,
      context_length: Number.MAX_SAFE_INTEGER,
    });
    expect(await quoteInferenceReservation(textInput())).toEqual({
      kind: 'unsupported',
      reason: 'reservation_amount_is_not_a_positive_safe_integer',
    });
  });

  it('rejects a transformed model or provider outside the fixed-price route', async () => {
    expect(
      (await quoteInferenceReservation({ ...textInput(), providerId: 'openrouter' })).kind
    ).toBe('unsupported');
    expect((await quoteInferenceReservation(textInput({ model: 'other/model' }))).kind).toBe(
      'unsupported'
    );
  });

  it('does not classify zero-cost or fallback-only billing as a guaranteed paid quote', async () => {
    jest.mocked(findKiloExclusiveModel).mockReturnValue({ ...exclusive, pricing: null });
    expect((await quoteInferenceReservation(textInput())).kind).toBe('unsupported');
    jest.mocked(findKiloExclusiveModel).mockReturnValue({
      ...exclusive,
      pricing: { tiers: fixedPricing.pricing, fallbackOnly: true },
    });
    expect((await quoteInferenceReservation(textInput())).kind).toBe('unsupported');
  });

  it.each([
    { tools: [{ type: 'web_search' }] },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }],
        },
      ],
    },
    { messages: [{ role: 'user', content: { image_url: 'https://example.invalid/image' } }] },
    { plugins: [{ id: 'web' }] },
    { models: ['other/model'] },
    { provider: { options: { vendor: { max_tokens: 999999 } } } },
    { previous_response_id: 'previous-operation' },
    { service_tier: 'priority' },
  ])('rejects unbounded media, hosted operations and routing overrides %s', async body => {
    expect((await quoteInferenceReservation(textInput(body))).kind).toBe('unsupported');
  });

  it('accepts local function schemas without treating tool schema types as media', async () => {
    expect(
      (
        await quoteInferenceReservation(
          textInput({
            tools: [
              { type: 'function', function: { name: 'local', parameters: { type: 'object' } } },
            ],
          })
        )
      ).kind
    ).toBe('quoted');
  });
});

describe('fixed custom prices', () => {
  beforeEach(() => {
    jest.mocked(findKiloExclusiveModel).mockReturnValue(null);
    jest.mocked(getCustomPricing).mockReturnValue(fixedPricing);
  });

  it.each(['openrouter', 'vercel'])(
    'does not use an input context as an omitted %s output cap',
    async providerId => {
      const input = {
        apiKind: 'responses',
        model: 'public/custom-model',
        providerId,
        body: { model: 'vendor/model', input: 'hello' },
      };
      expect(await quoteInferenceReservation(input)).toEqual({
        kind: 'unsupported',
        reason: 'fixed_custom_pricing_missing_declared_model_output_and_reasoning_ceiling',
      });
      expect(input.body).not.toHaveProperty('max_output_tokens');
    }
  );

  it('recognizes real unconditional Gemini billing but still requires a declared output ceiling', async () => {
    const actual = jest.requireActual<{ getCustomPricing: typeof getCustomPricing }>(
      '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants'
    );
    jest.mocked(getCustomPricing).mockImplementation(actual.getCustomPricing);
    const modelId = 'google/gemini-3.8-flash';
    expect(
      await quoteInferenceReservation({
        apiKind: 'chat_completions',
        model: modelId,
        providerId: 'openrouter',
        body: { model: modelId, max_tokens: 1 },
      })
    ).toEqual({
      kind: 'unsupported',
      reason: 'fixed_custom_pricing_missing_declared_model_output_and_reasoning_ceiling',
    });
    expect(
      calculateCustomCost_mUsd(modelId, {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        cost_mUsd: 999999,
        is_byok: false,
      })
    ).toBe(4500);
  });

  it('does not claim a fixed ceiling when fallbackOnly leaves positive market cost authoritative', async () => {
    jest.mocked(getCustomPricing).mockReturnValue({ ...fixedPricing, fallbackOnly: true });
    expect(
      calculateCustomCost_mUsd('vendor/model', {
        inputTokens: 1,
        outputTokens: 1,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        cost_mUsd: 999999,
        is_byok: false,
      })
    ).toBeUndefined();
    expect(
      (
        await quoteInferenceReservation({
          apiKind: 'chat_completions',
          model: 'vendor/model',
          providerId: 'openrouter',
          body: { model: 'vendor/model' },
        })
      ).kind
    ).toBe('unsupported');
  });

  it('does not substitute missing output metadata or an unsupported provider with a zero quote', async () => {
    expect(
      (await quoteInferenceReservation({ ...textInput(), providerId: 'openrouter' })).kind
    ).toBe('unsupported');
    expect((await quoteInferenceReservation({ ...textInput(), providerId: 'custom' })).kind).toBe(
      'unsupported'
    );
  });
});

describe('direct FIM and edit billing', () => {
  it.each([
    ['fim_completions', 'mistral', 'mistralai/codestral-2508', 'codestral-2508', 77700],
    ['fim_completions', 'inception', 'inception/mercury-edit-2', 'mercury-edit-2', 32750],
    ['edit_completions', 'inception', 'inception/mercury-edit-2', 'mercury-edit-2', 32750],
  ] as const)(
    'bounds %s %s with a full input context plus explicit output cap',
    async (apiKind, providerId, model, upstreamModel, amountMicrodollars) => {
      expect(
        await quoteInferenceReservation({
          apiKind,
          providerId,
          model,
          body: {
            model: upstreamModel,
            prompt: 'prefix',
            suffix: 'suffix',
            messages: [{ role: 'user', content: 'edit this' }],
            max_tokens: 1000,
          },
        })
      ).toEqual({ kind: 'quoted', amountMicrodollars });
    }
  );

  it.each([undefined, 0, -1, 1.1, 1001, Number.POSITIVE_INFINITY])(
    'requires a validated direct output cap %s',
    async max_tokens => {
      expect(
        (
          await quoteInferenceReservation({
            apiKind: 'fim_completions',
            providerId: 'mistral',
            model: 'mistralai/codestral-2508',
            body: { model: 'codestral-2508', prompt: 'prefix', max_tokens },
          })
        ).kind
      ).toBe('unsupported');
    }
  );

  it('rounds fractional microdollars upward at the smallest output boundary', async () => {
    expect(
      await quoteInferenceReservation({
        apiKind: 'fim_completions',
        providerId: 'inception',
        model: 'mercury-edit-2',
        body: { model: 'mercury-edit-2', prompt: '', max_tokens: 1 },
      })
    ).toEqual({ kind: 'quoted', amountMicrodollars: 32001 });
  });
});

describe('unsupported billing contracts', () => {
  it.each([
    ['embeddings', 'embeddings_require_aggregate_batch_token_and_maximum_route_price_contracts'],
    [
      'audio_transcriptions',
      'transcription_requires_verified_audio_duration_token_and_fee_ceilings',
    ],
    [
      'systemone',
      'systemone_requires_question_expansion_sample_and_maximum_route_charge_contracts',
    ],
  ])('reports the genuine missing %s ceiling', async (apiKind, reason) => {
    expect(
      await quoteInferenceReservation({
        apiKind,
        model: 'vendor/model',
        providerId: 'openrouter',
        body: {},
      })
    ).toEqual({ kind: 'unsupported', reason });
  });

  it('does not promote arbitrary market or display prices into a maximum', async () => {
    jest.mocked(findKiloExclusiveModel).mockReturnValue(null);
    expect(
      await quoteInferenceReservation({
        apiKind: 'chat_completions',
        model: 'vendor/model',
        providerId: 'openrouter',
        body: { model: 'vendor/model' },
      })
    ).toEqual({
      kind: 'unsupported',
      reason: 'missing_maximum_route_price_and_token_contract:openrouter:vendor/model',
    });
  });

  it.each([null, [], 'not-json', 123])('rejects non-object request bodies %s', async body => {
    expect((await quoteInferenceReservation({ ...textInput(), body })).kind).toBe('unsupported');
  });
});
