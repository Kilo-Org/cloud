import { describe, it, expect } from '@jest/globals';
import {
  convertProviderOptions,
  getAnthropicProviderOptionsForVercel,
  getVercelInferenceProvidersExcludingIgnored,
  hasCompatibleVercelInferenceProvider,
  passesVercelRoutingPercentage,
} from '@/lib/ai-gateway/providers/vercel';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

describe('getAnthropicProviderOptionsForVercel', () => {
  it('maps chat completion verbosity to Anthropic effort', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        verbosity: 'high',
      },
    };

    expect(getAnthropicProviderOptionsForVercel(request)).toEqual({
      effort: 'high',
    });
  });

  it('maps responses text verbosity to Anthropic effort', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        input: 'hello',
        text: { verbosity: 'low' },
      },
    };

    expect(getAnthropicProviderOptionsForVercel(request)).toEqual({
      effort: 'low',
    });
  });

  it('returns undefined when no Anthropic options are needed', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    expect(getAnthropicProviderOptionsForVercel(request)).toBe(undefined);
  });
});

describe('hasCompatibleVercelInferenceProvider', () => {
  it('accepts when a translated OpenRouter provider is available on Vercel', () => {
    expect(hasCompatibleVercelInferenceProvider(['amazon-bedrock'], ['anthropic', 'bedrock'])).toBe(
      true
    );
  });

  it('rejects when none of the requested providers are available on Vercel', () => {
    expect(hasCompatibleVercelInferenceProvider(['google-vertex'], ['anthropic', 'bedrock'])).toBe(
      false
    );
  });

  it('rejects an empty only list when provider data is available', () => {
    expect(hasCompatibleVercelInferenceProvider([], ['anthropic'])).toBe(false);
  });

  it('accepts when the model has no cached provider entry', () => {
    expect(hasCompatibleVercelInferenceProvider(['google-vertex'], null)).toBe(true);
  });
});

describe('getVercelInferenceProvidersExcludingIgnored', () => {
  it('returns available providers minus translated ignored providers', () => {
    expect(
      getVercelInferenceProvidersExcludingIgnored(['amazon-bedrock'], undefined, [
        'anthropic',
        'bedrock',
        'vertex',
      ])
    ).toEqual(['anthropic', 'vertex']);
  });

  it('intersects the available providers with only before excluding ignored providers', () => {
    expect(
      getVercelInferenceProvidersExcludingIgnored(
        ['google-vertex'],
        ['amazon-bedrock', 'google-vertex', 'openai'],
        ['anthropic', 'bedrock', 'vertex']
      )
    ).toEqual(['bedrock']);
  });

  it('returns an empty list when all available providers are ignored', () => {
    expect(
      getVercelInferenceProvidersExcludingIgnored(['anthropic', 'amazon-bedrock'], undefined, [
        'anthropic',
        'bedrock',
      ])
    ).toEqual([]);
  });
});

describe('convertProviderOptions', () => {
  it('emits only available non-ignored providers without changing provider.only', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        provider: {
          only: ['anthropic', 'amazon-bedrock'],
          ignore: ['amazon-bedrock'],
        },
      },
    };

    const provider = request.body.provider;
    const providerOptions = convertProviderOptions(request, ['anthropic', 'bedrock', 'vertex']);

    expect(providerOptions.gateway?.only).toEqual(['anthropic']);
    expect(provider?.only).toEqual(['anthropic', 'amazon-bedrock']);
  });
});

describe('passesVercelRoutingPercentage', () => {
  it('never passes at 0% and always passes at 100%', () => {
    for (let seed = 0; seed < 1_000; seed++) {
      expect(passesVercelRoutingPercentage(String(seed), 0)).toBe(false);
      expect(passesVercelRoutingPercentage(String(seed), 100)).toBe(true);
    }
  });

  it('preserves whole-percentage routing cohorts', () => {
    for (let seed = 0; seed < 1_000; seed++) {
      const randomSeed = String(seed);
      const previousDecision = getRandomNumber('vercel_routing_' + randomSeed, 100) < 63;

      expect(passesVercelRoutingPercentage(randomSeed, 63)).toBe(previousDecision);
    }
  });

  it('routes a fractional portion of the next percentage bucket', () => {
    const seedsInFinalBucket = Array.from({ length: 10_000 }, (_, seed) => String(seed)).filter(
      seed => getRandomNumber('vercel_routing_' + seed, 100) === 99
    );

    expect(seedsInFinalBucket.some(seed => passesVercelRoutingPercentage(seed, 99.9))).toBe(true);
    expect(seedsInFinalBucket.some(seed => !passesVercelRoutingPercentage(seed, 99.9))).toBe(true);
  });
});
