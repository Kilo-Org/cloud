import { describe, it, expect, jest } from '@jest/globals';
import {
  applyVercelSettings,
  getAnthropicProviderOptionsForVercel,
  hasCompatibleVercelInferenceProvider,
  passesVercelRoutingPercentage,
} from '@/lib/ai-gateway/providers/vercel';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { getCachedVercelInferenceProviderIdsForModel } from '@/lib/ai-gateway/providers/gateway-models-cache';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getCachedVercelInferenceProviderIdsForModel: jest.fn(),
}));

const mockedGetCachedVercelInferenceProviderIdsForModel = jest.mocked(
  getCachedVercelInferenceProviderIdsForModel
);

function createDeepseekRequest(only?: string[]): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'hello' }],
      provider: only ? { only } : undefined,
    },
  };
}

describe('applyVercelSettings', () => {
  it('removes Novita from an explicit DeepSeek provider list', async () => {
    const request = createDeepseekRequest(['Novita/fp8', 'deepseek']);

    await applyVercelSettings('deepseek/deepseek-v3.2', request, null);

    expect(request.body.providerOptions?.gateway?.only).toEqual(['deepseek']);
    expect(mockedGetCachedVercelInferenceProviderIdsForModel).not.toHaveBeenCalled();
  });

  it('allows DeepSeek when the explicit provider list only contains Novita', async () => {
    const request = createDeepseekRequest(['novita']);

    await applyVercelSettings('deepseek/deepseek-v3.2', request, null);

    expect(request.body.providerOptions?.gateway?.only).toBe(undefined);
    expect(mockedGetCachedVercelInferenceProviderIdsForModel).not.toHaveBeenCalled();
  });

  it('uses the cached Vercel providers without Novita for DeepSeek', async () => {
    mockedGetCachedVercelInferenceProviderIdsForModel.mockResolvedValueOnce([
      'novita',
      'deepseek',
      'bedrock',
    ]);
    const request = createDeepseekRequest();

    await applyVercelSettings('deepseek/deepseek-v3.2', request, null);

    expect(request.body.providerOptions?.gateway?.only).toEqual(['deepseek', 'bedrock']);
  });

  it('leaves only undefined when DeepSeek has no cached provider list', async () => {
    mockedGetCachedVercelInferenceProviderIdsForModel.mockResolvedValueOnce(null);
    const request = createDeepseekRequest();

    await applyVercelSettings('deepseek/deepseek-v3.2', request, null);

    expect(request.body.providerOptions?.gateway?.only).toBe(undefined);
  });
});

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
