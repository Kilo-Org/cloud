import { describe, it, expect } from '@jest/globals';
import {
  applyVercelSettings,
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
});

describe('applyVercelSettings Tencent free model API key', () => {
  const originalTencentFreeApiKey = process.env.TENCENT_FREE_API_KEY;

  afterEach(() => {
    if (originalTencentFreeApiKey !== undefined) {
      process.env.TENCENT_FREE_API_KEY = originalTencentFreeApiKey;
    } else {
      delete process.env.TENCENT_FREE_API_KEY;
    }
  });

  it('uses TENCENT_FREE_API_KEY for the free Tencent model in the non-user-byok case', async () => {
    process.env.TENCENT_FREE_API_KEY = 'test-tencent-free-key';

    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'tencent/hy3:free',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    await applyVercelSettings('tencent/hy3:free', request, null);

    expect(request.body.model).toBe('tencent/hy3');
    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      tencent: [{ apiKey: 'test-tencent-free-key' }],
    });
  });

  it('does not use TENCENT_FREE_API_KEY when referenced by internal id in the non-user-byok case', async () => {
    process.env.TENCENT_FREE_API_KEY = 'test-tencent-free-key';

    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'tencent/hy3',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    await applyVercelSettings('tencent/hy3', request, null);

    expect(request.body.model).toBe('tencent/hy3');
    expect(request.body.providerOptions?.gateway?.byok).toBeUndefined();
  });

  it('does not set byok when TENCENT_FREE_API_KEY is not set', async () => {
    delete process.env.TENCENT_FREE_API_KEY;

    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'tencent/hy3:free',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    await applyVercelSettings('tencent/hy3:free', request, null);

    expect(request.body.model).toBe('tencent/hy3');
    expect(request.body.providerOptions?.gateway?.byok).toBeUndefined();
  });

  it('does not set Tencent byok for non-Tencent models even when TENCENT_FREE_API_KEY is set', async () => {
    process.env.TENCENT_FREE_API_KEY = 'test-tencent-free-key';

    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    await applyVercelSettings('anthropic/claude-sonnet-4.5', request, null);

    expect(request.body.providerOptions?.gateway?.byok).toBeUndefined();
  });

  it('does not use TENCENT_FREE_API_KEY when userByok is provided for the free Tencent model', async () => {
    process.env.TENCENT_FREE_API_KEY = 'test-tencent-free-key';

    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'tencent/hy3:free',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    await applyVercelSettings('tencent/hy3:free', request, [
      { decryptedAPIKey: 'user-novita-key', providerId: 'novita' },
    ]);

    expect(request.body.model).toBe('tencent/hy3');
    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      novita: [{ apiKey: 'user-novita-key' }],
    });
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
