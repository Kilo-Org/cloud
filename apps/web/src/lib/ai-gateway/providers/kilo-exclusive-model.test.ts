import { describe, it, expect } from '@jest/globals';
import {
  applyKiloExclusiveModelSettings,
  calculateCost_mUsd,
  convertFromKiloExclusiveModel,
  type KiloExclusiveModel,
  type PricingTiers,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type { OpenRouterInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

function makeModel(
  overrides: Partial<KiloExclusiveModel> & Pick<KiloExclusiveModel, 'internal_id'>
): KiloExclusiveModel {
  return {
    public_id: 'kilo/test-model',
    display_name: 'Test',
    description: '',
    context_length: 0,
    max_completion_tokens: 0,
    status: 'public',
    flags: [],
    gateway: 'openrouter',
    pricing: null,
    exclusive_to: [],
    inference_provider_restriction: [],
    ...overrides,
  };
}

function makeRequest(
  provider?: OpenRouterProviderConfig,
  model = 'public/id'
): GatewayRequest & { kind: 'chat_completions' } {
  const body: OpenRouterChatCompletionRequest = {
    model,
    messages: [],
    ...(provider ? { provider } : {}),
  } as OpenRouterChatCompletionRequest;
  return { kind: 'chat_completions', body };
}

const usage = {
  uncachedInputTokens: 100,
  totalOutputTokens: 0,
  cacheWriteTokens: 0,
  cacheHitTokens: 0,
};

const pricing = (prompt_per_million: number) => ({
  prompt_per_million,
  completion_per_million: 0,
  input_cache_read_per_million: null,
  input_cache_write_per_million: null,
});

describe('calculateCost_mUsd', () => {
  it('selects the tier whose start context length is reached', () => {
    const pricingTiers: PricingTiers = [
      { start_context_length: 0, pricing: pricing(1) },
      { start_context_length: 100, pricing: pricing(2) },
      { start_context_length: 200, pricing: pricing(3) },
    ];

    expect(calculateCost_mUsd(usage, pricingTiers)).toBe(200);
  });

  it('requires the first tier to start at zero', () => {
    const pricingTiers: PricingTiers = [{ start_context_length: 1, pricing: pricing(1) }];

    expect(() => calculateCost_mUsd(usage, pricingTiers)).toThrow(
      'The first pricing tier must start at context length 0'
    );
  });

  it('requires tiers to be ordered by ascending start context length', () => {
    const pricingTiers: PricingTiers = [
      { start_context_length: 0, pricing: pricing(1) },
      { start_context_length: 200, pricing: pricing(2) },
      { start_context_length: 100, pricing: pricing(3) },
    ];

    expect(() => calculateCost_mUsd(usage, pricingTiers)).toThrow(
      'Pricing tiers must be ordered by ascending start context length'
    );
  });
});

describe('convertFromKiloExclusiveModel', () => {
  it('only exposes the cheapest pricing tier in model metadata', () => {
    const model = makeModel({
      internal_id: 'vendor/x',
      pricing: [
        { start_context_length: 0, pricing: pricing(1) },
        { start_context_length: 100, pricing: pricing(2) },
      ],
    });

    expect(convertFromKiloExclusiveModel(model).pricing.prompt).toBe('0.000001000000');
  });
});

describe('applyKiloExclusiveModelSettings', () => {
  it('rewrites the public model id to the internal id', () => {
    const req = makeRequest(undefined, 'kilo/test-model');
    applyKiloExclusiveModelSettings(req, makeModel({ internal_id: 'vendor/real-model' }));
    expect(req.body.model).toBe('vendor/real-model');
  });

  it('leaves provider untouched when there is no restriction', () => {
    const req = makeRequest({ only: ['anthropic'], zdr: true });
    applyKiloExclusiveModelSettings(req, makeModel({ internal_id: 'vendor/x' }));
    expect(req.body.provider).toEqual({ only: ['anthropic'], zdr: true });
  });

  it('creates provider.only when no provider block is present', () => {
    const req = makeRequest(undefined);
    applyKiloExclusiveModelSettings(
      req,
      makeModel({
        internal_id: 'vendor/x',
        inference_provider_restriction: [
          'anthropic',
          'amazon-bedrock',
        ] as OpenRouterInferenceProviderId[],
      })
    );
    expect(req.body.provider).toEqual({ only: ['anthropic', 'amazon-bedrock'] });
  });

  it('adds only to an existing provider block that has no only set', () => {
    const req = makeRequest({ zdr: true });
    applyKiloExclusiveModelSettings(
      req,
      makeModel({
        internal_id: 'vendor/x',
        inference_provider_restriction: ['anthropic'] as OpenRouterInferenceProviderId[],
      })
    );
    expect(req.body.provider).toEqual({ zdr: true, only: ['anthropic'] });
  });

  it('overwrites a malformed provider value', () => {
    const req = makeRequest();
    Object.assign(req.body, { provider: 'lmstudio' });
    applyKiloExclusiveModelSettings(
      req,
      makeModel({
        internal_id: 'vendor/x',
        inference_provider_restriction: ['anthropic'] as OpenRouterInferenceProviderId[],
      })
    );
    expect(req.body.provider).toEqual({ only: ['anthropic'] });
  });

  it('intersects caller-supplied only with the restriction', () => {
    const req = makeRequest({ only: ['anthropic', 'openai', 'amazon-bedrock'] });
    applyKiloExclusiveModelSettings(
      req,
      makeModel({
        internal_id: 'vendor/x',
        inference_provider_restriction: [
          'anthropic',
          'amazon-bedrock',
        ] as OpenRouterInferenceProviderId[],
      })
    );
    expect(req.body.provider?.only?.sort()).toEqual(['amazon-bedrock', 'anthropic']);
  });

  it('produces an empty only list when caller only and restriction are disjoint', () => {
    const req = makeRequest({ only: ['openai'] });
    applyKiloExclusiveModelSettings(
      req,
      makeModel({
        internal_id: 'vendor/x',
        inference_provider_restriction: ['anthropic'] as OpenRouterInferenceProviderId[],
      })
    );
    expect(req.body.provider?.only).toEqual([]);
  });

  it('does not clone shared configuration when there is no restriction', () => {
    const sharedProvider: OpenRouterProviderConfig = { only: ['openai'] };
    const req = makeRequest(sharedProvider);
    applyKiloExclusiveModelSettings(req, makeModel({ internal_id: 'vendor/x' }));
    expect(req.body.provider).toBe(sharedProvider);
    expect(sharedProvider.only).toEqual(['openai']);
  });
});
