import { describe, it, expect } from '@jest/globals';
import {
  applyVercelSettings,
  convertProviderOptions,
  getAnthropicProviderOptionsForVercel,
  getVercelInferenceProvidersExcludingIgnored,
  hasVercelProvidersButNoOpenRouterProviders,
  hasCompatibleVercelInferenceProvider,
  isVercelRoutingOptOut,
  passesVercelRoutingPercentage,
} from '@/lib/ai-gateway/providers/vercel';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

const originalFriendliApiKey = process.env.FRIENDLI_API_KEY;

afterEach(() => {
  if (originalFriendliApiKey === undefined) {
    delete process.env.FRIENDLI_API_KEY;
  } else {
    process.env.FRIENDLI_API_KEY = originalFriendliApiKey;
  }
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

describe('hasVercelProvidersButNoOpenRouterProviders', () => {
  const requestedModel = 'vendor/model';

  it('returns true when only Vercel has inference providers', () => {
    expect(
      hasVercelProvidersButNoOpenRouterProviders(requestedModel, new Set([requestedModel]), [
        'provider',
      ])
    ).toBe(true);
  });

  it('returns false when OpenRouter still has inference providers', () => {
    expect(
      hasVercelProvidersButNoOpenRouterProviders(requestedModel, new Set(), ['provider'])
    ).toBe(false);
  });

  it('returns false when Vercel has no inference providers', () => {
    expect(
      hasVercelProvidersButNoOpenRouterProviders(requestedModel, new Set([requestedModel]), [])
    ).toBe(false);
  });

  it('returns false when Vercel provider data is unavailable', () => {
    expect(
      hasVercelProvidersButNoOpenRouterProviders(requestedModel, new Set([requestedModel]), null)
    ).toBe(false);
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

describe('applyVercelSettings BYOK pinning', () => {
  function byokRequest(ignore: string[]): GatewayRequest {
    return {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        provider: { ignore },
      },
    };
  }

  // `userByok` is built from the providers that actually serve the requested
  // model, so the realistic partial-ignore case is two endpoints for the same
  // model: Anthropic direct and Bedrock both serve Claude.
  const bedrockCredentials = JSON.stringify({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-east-1',
  });

  it('drops a BYOK provider the caller ignored when another serving provider remains', async () => {
    const request = byokRequest(['anthropic']);

    await applyVercelSettings('anthropic/claude-sonnet-4.5', request, [
      { decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' },
      { decryptedAPIKey: bedrockCredentials, providerId: 'bedrock' },
    ]);

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      bedrock: [{ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' }],
    });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['bedrock']);
  });

  // Regression: an empty BYOK map sends `only: []` with no credential, so the
  // request loses BYOK pinning and bills Kilo's Vercel account while still
  // counting as BYOK downstream (which skips the zero-balance rejection).
  it('keeps BYOK credentials when the caller ignores every provider it holds keys for', async () => {
    const request = byokRequest(['anthropic']);

    await applyVercelSettings('anthropic/claude-sonnet-4.5', request, [
      { decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' },
    ]);

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      anthropic: [{ apiKey: 'sk-anthropic' }],
    });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['anthropic']);
  });

  it('does not add managed Friendli credentials to user BYOK settings', async () => {
    process.env.FRIENDLI_API_KEY = 'friendli-managed-key';
    const request = byokRequest([]);

    await applyVercelSettings('anthropic/claude-sonnet-4.5', request, [
      { decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' },
    ]);

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      anthropic: [{ apiKey: 'sk-anthropic' }],
    });
  });
});

describe('applyVercelSettings managed requests', () => {
  function managedRequest(): GatewayRequest {
    return {
      kind: 'chat_completions',
      body: {
        model: 'moonshotai/kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };
  }

  it('does not add managed Friendli credentials from the environment', async () => {
    process.env.FRIENDLI_API_KEY = 'friendli-managed-key';
    const request = managedRequest();

    await applyVercelSettings('moonshotai/kimi-k3', request, null);

    expect(request.body.providerOptions?.gateway?.byok).toBeUndefined();
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

describe('isVercelRoutingOptOut', () => {
  it('only opts out exact model ID matches', () => {
    const optOutModels = new Set(['moonshotai/kimi-k3']);

    expect(isVercelRoutingOptOut('moonshotai/kimi-k3', optOutModels)).toBe(true);
    expect(isVercelRoutingOptOut('moonshotai/kimi-k3-fast', optOutModels)).toBe(false);
  });
});
