import {
  OrganizationDataRegionSchema,
  type OrganizationDataRegion,
} from '@kilocode/db/schema-types';
import { afterEach, describe, it, expect, jest } from '@jest/globals';

import {
  applyVercelSettings,
  convertProviderOptions,
  getAnthropicProviderOptionsForVercel,
  getVercelInferenceProvidersExcludingIgnored,
  hasCompatibleVercelInferenceProvider,
  isVercelRoutingOptOut,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { legacyOpenRouterAliases } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

const originalFriendliApiKey = process.env.FRIENDLI_API_KEY;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalFriendliApiKey === undefined) {
    delete process.env.FRIENDLI_API_KEY;
  } else {
    process.env.FRIENDLI_API_KEY = originalFriendliApiKey;
  }
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
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

  it('accepts Google Vertex preferences for Vertex Anthropic endpoint metadata', () => {
    expect(hasCompatibleVercelInferenceProvider(['google-vertex'], ['vertexAnthropic'])).toBe(true);
  });

  it('accepts providers outside the known provider registry', () => {
    expect(hasCompatibleVercelInferenceProvider(['future-provider'], ['future-provider'])).toBe(
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

  it('excludes normalized Vertex Anthropic endpoints for Google Vertex ignores', () => {
    expect(
      getVercelInferenceProvidersExcludingIgnored(['google-vertex'], undefined, [
        'anthropic',
        'vertexAnthropic',
      ])
    ).toEqual(['anthropic']);
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

  it('preserves and filters providers outside the known provider registry', () => {
    expect(
      getVercelInferenceProvidersExcludingIgnored(['future-provider'], undefined, [
        'anthropic',
        'future-provider',
        'another-future-provider',
      ])
    ).toEqual(['anthropic', 'another-future-provider']);
  });
});

describe('convertProviderOptions', () => {
  it.each([
    { sort: 'price', expected: 'cost' },
    { sort: 'throughput', expected: 'tps' },
    { sort: 'latency', expected: 'ttft' },
  ] as const)(
    'converts sort $sort to $expected alongside existing preferences',
    ({ sort, expected }) => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'anthropic/claude-sonnet-4.5',
          messages: [{ role: 'user', content: 'hello' }],
          provider: {
            sort,
            only: ['anthropic', 'amazon-bedrock'],
            order: ['amazon-bedrock'],
            zdr: true,
            data_collection: 'deny',
          },
        },
      };
      const originalRequest = structuredClone(request);

      expect(convertProviderOptions(request, null).gateway).toMatchObject({
        sort: expected,
        only: ['anthropic', 'bedrock'],
        order: ['bedrock'],
        zeroDataRetention: true,
        disallowPromptTraining: true,
      });
      expect(request).toEqual(originalRequest);
    }
  );

  it.each([
    undefined,
    null,
    'future-sort',
    'toString',
    42,
    true,
    ['price'],
    {},
    { by: 'price' },
    { by: 'latency', partition: 'none' },
  ])('omits unsupported sort %j without rejecting the conversion', sort => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        provider: { sort: sort as OpenRouterProviderConfig['sort'] },
      },
    };

    expect(convertProviderOptions(request, null).gateway?.sort).toBeUndefined();
  });

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

  it('passes providers outside the known provider registry through unchanged', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'future/model',
        messages: [{ role: 'user', content: 'hello' }],
        provider: {
          only: ['future-provider'],
          order: ['another-future-provider'],
        },
      },
    };

    expect(convertProviderOptions(request, null).gateway).toMatchObject({
      only: ['future-provider'],
      order: ['another-future-provider'],
    });
  });

  it('filters ignored providers from an explicit only list when metadata is unavailable', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'vendor/model',
        messages: [{ role: 'user', content: 'hello' }],
        provider: {
          only: ['gmicloud', 'openai'],
          ignore: ['openai'],
        },
      },
    };

    expect(convertProviderOptions(request, null).gateway?.only).toEqual(['gmicloud']);
  });

  it('still rejects ignore-only routing when metadata is unavailable', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'vendor/model',
        messages: [{ role: 'user', content: 'hello' }],
        provider: { ignore: ['openai'] },
      },
    };

    expect(() => convertProviderOptions(request, null)).toThrow(
      'Vercel inference provider data became unavailable during request transform'
    );
  });
});

const unrestrictedRouting = {
  requestedModel: 'anthropic/claude-sonnet-4.5',
  boundedSpending: false,
};

describe('shouldRouteToVercel', () => {
  async function loadShouldRouteToVercel(
    options: {
      model?: string;
      optOut?: boolean;
      /** The model's stored OpenRouter endpoint tags, or null when OpenRouter does not list it. */
      openRouterEndpointTags?: string[] | null;
      vercelInferenceProviders?: string[] | null;
    } = {}
  ) {
    const {
      model = 'anthropic/claude-sonnet-4.5',
      optOut = false,
      openRouterEndpointTags = ['anthropic'],
      vercelInferenceProviders = ['anthropic'],
    } = options;
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/routing-config', () => ({
      getRuntimeGatewayRoutingConfig: jest.fn(async () => ({
        vercelOptOutModels: new Set(optOut ? [model] : []),
      })),
    }));
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getVercelModelsFromDatabase: jest.fn(async () => new Set([model])),
      getCachedVercelInferenceProviderIdsForModel: jest.fn(async () => vercelInferenceProviders),
      getOpenRouterModelsMetadataFromDatabase: jest.fn(async () =>
        openRouterEndpointTags
          ? { [model]: { id: model, endpoints: openRouterEndpointTags.map(tag => ({ tag })) } }
          : {}
      ),
    }));
    return (await import('@kilocode/web-shared/lib/ai-gateway/providers/vercel'))
      .shouldRouteToVercel;
  }

  it('uses resolved provider policy instead of unrestricted request preferences', async () => {
    const shouldRouteToVercel = await loadShouldRouteToVercel();

    await expect(
      shouldRouteToVercel(unrestrictedRouting, async () => ({
        only: ['google-vertex'],
      }))
    ).resolves.toBe(false);
  });

  it('routes to Vercel when the resolved provider policy allows a Vercel provider', async () => {
    const shouldRouteToVercel = await loadShouldRouteToVercel();

    await expect(
      shouldRouteToVercel(unrestrictedRouting, async () => ({
        only: ['anthropic'],
      }))
    ).resolves.toBe(true);
  });

  it('allows Vercel routing with an unrecognized sort preference', async () => {
    const shouldRouteToVercel = await loadShouldRouteToVercel();
    const provider: OpenRouterProviderConfig = {
      sort: 'future-sort' as OpenRouterProviderConfig['sort'],
      only: ['anthropic'],
    };

    await expect(shouldRouteToVercel(unrestrictedRouting, async () => provider)).resolves.toBe(
      true
    );
  });

  it('routes eligible traffic to Vercel without per-user randomization', async () => {
    const shouldRouteToVercel = await loadShouldRouteToVercel();

    await expect(shouldRouteToVercel(unrestrictedRouting, async () => undefined)).resolves.toBe(
      true
    );
  });

  describe('with a model opted out of Vercel routing', () => {
    // Telnyx serves this model on Vercel but not on OpenRouter.
    const model = 'deepseek/deepseek-v4.1-flash-1017';
    const routing = { requestedModel: model, boundedSpending: false };
    const providerData = {
      model,
      openRouterEndpointTags: ['deepseek', 'deepinfra/fp8'],
      vercelInferenceProviders: ['deepseek', 'telnyx'],
    };

    it('stays on OpenRouter without provider routing settings', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ ...providerData, optOut: true });

      await expect(shouldRouteToVercel(routing, async () => undefined)).resolves.toBe(false);
    });

    it('routes to Vercel when only Vercel serves the providers `only` allows', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ ...providerData, optOut: true });

      await expect(shouldRouteToVercel(routing, async () => ({ only: ['telnyx'] }))).resolves.toBe(
        true
      );
    });

    it('stays on OpenRouter when `only` allows a provider OpenRouter serves', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ ...providerData, optOut: true });

      await expect(
        shouldRouteToVercel(routing, async () => ({ only: ['telnyx', 'deepinfra'] }))
      ).resolves.toBe(false);
    });

    it.each([true, false])(
      'stays on OpenRouter when `only` names providers on neither gateway (opted out: %s)',
      async optOut => {
        const shouldRouteToVercel = await loadShouldRouteToVercel({ ...providerData, optOut });

        await expect(
          shouldRouteToVercel(routing, async () => ({ only: ['unknown-provider'] }))
        ).resolves.toBe(false);
      }
    );

    it('routes to Vercel when ignored providers leave only Vercel providers', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ ...providerData, optOut: true });

      await expect(
        shouldRouteToVercel(routing, async () => ({ ignore: ['deepseek', 'deepinfra'] }))
      ).resolves.toBe(true);
    });

    it('stays on OpenRouter when its endpoints for the model are unknown', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({
        ...providerData,
        optOut: true,
        openRouterEndpointTags: null,
      });

      await expect(shouldRouteToVercel(routing, async () => ({ only: ['telnyx'] }))).resolves.toBe(
        false
      );
    });

    it('stays on OpenRouter when Vercel inference provider data is unavailable', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({
        ...providerData,
        optOut: true,
        vercelInferenceProviders: null,
      });

      await expect(shouldRouteToVercel(routing, async () => ({ only: ['telnyx'] }))).resolves.toBe(
        false
      );
    });

    it('leaves a spend-bounded request on OpenRouter', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ ...providerData, optOut: true });

      await expect(
        shouldRouteToVercel({ ...routing, boundedSpending: true }, async () => ({
          only: ['telnyx'],
        }))
      ).resolves.toBe(false);
    });
  });

  it('leaves a spend-bounded request on OpenRouter without resolving provider policy', async () => {
    const shouldRouteToVercel = await loadShouldRouteToVercel();
    const getRoutingProviderConfig = jest.fn(async () => undefined);

    await expect(
      shouldRouteToVercel(
        { ...unrestrictedRouting, boundedSpending: true },
        getRoutingProviderConfig
      )
    ).resolves.toBe(false);
    expect(getRoutingProviderConfig).not.toHaveBeenCalled();
  });

  describe('with OpenRouter disabled', () => {
    const openRouterDisabled = { ...unrestrictedRouting, openRouterDisabled: true };

    it('routes a model opted out of Vercel routing to Vercel', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ optOut: true });

      await expect(shouldRouteToVercel(openRouterDisabled, async () => undefined)).resolves.toBe(
        true
      );
    });

    it('still honors the opt-out list when OpenRouter is not disabled', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ optOut: true });

      await expect(
        shouldRouteToVercel(
          { ...unrestrictedRouting, openRouterDisabled: false },
          async () => undefined
        )
      ).resolves.toBe(false);
    });

    it('leaves a spend-bounded request off Vercel', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ optOut: true });
      const getRoutingProviderConfig = jest.fn(async () => undefined);

      await expect(
        shouldRouteToVercel(
          { ...openRouterDisabled, boundedSpending: true },
          getRoutingProviderConfig
        )
      ).resolves.toBe(false);
      expect(getRoutingProviderConfig).not.toHaveBeenCalled();
    });

    it('does not route a model Vercel does not serve', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ optOut: true });

      await expect(
        shouldRouteToVercel(
          { ...openRouterDisabled, requestedModel: 'vendor/unknown-model' },
          async () => undefined
        )
      ).resolves.toBe(false);
    });

    it('still applies the resolved provider policy', async () => {
      const shouldRouteToVercel = await loadShouldRouteToVercel({ optOut: true });

      await expect(
        shouldRouteToVercel(openRouterDisabled, async () => ({ only: ['google-vertex'] }))
      ).resolves.toBe(false);
    });
  });
});

describe('canRouteToVercel', () => {
  async function loadCanRouteToVercel(vercelInferenceProviders: string[] | null = ['anthropic']) {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getVercelModelsFromDatabase: jest.fn(async () => new Set(['anthropic/claude-sonnet-4.5'])),
      getCachedVercelInferenceProviderIdsForModel: jest.fn(async () => vercelInferenceProviders),
    }));
    return (await import('@kilocode/web-shared/lib/ai-gateway/providers/vercel')).canRouteToVercel;
  }

  it('rejects a model Vercel does not serve', async () => {
    const canRouteToVercel = await loadCanRouteToVercel();

    await expect(canRouteToVercel('vendor/unknown-model', async () => undefined)).resolves.toBe(
      false
    );
  });

  it('rejects an only list with no provider available on Vercel', async () => {
    const canRouteToVercel = await loadCanRouteToVercel();

    await expect(
      canRouteToVercel('anthropic/claude-sonnet-4.5', async () => ({ only: ['google-vertex'] }))
    ).resolves.toBe(false);
  });

  it('rejects an ignore list when inference provider data is unavailable', async () => {
    const canRouteToVercel = await loadCanRouteToVercel(null);

    await expect(
      canRouteToVercel('anthropic/claude-sonnet-4.5', async () => ({ ignore: ['openai'] }))
    ).resolves.toBe(false);
  });

  it('accepts a served model with compatible provider settings', async () => {
    const canRouteToVercel = await loadCanRouteToVercel();

    await expect(
      canRouteToVercel('anthropic/claude-sonnet-4.5', async () => ({
        only: ['anthropic'],
        ignore: ['amazon-bedrock'],
      }))
    ).resolves.toBe(true);
  });
});

describe('isValidVercelModelId', () => {
  async function loadIsValidVercelModelId({
    vercelModelIds,
    openRouterModelIds = [],
    overrides = [],
    aliases = {},
  }: {
    vercelModelIds: string[];
    openRouterModelIds?: string[];
    overrides?: [string, string][];
    aliases?: Record<string, string>;
  }) {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getVercelModelsFromDatabase: jest.fn(async () => new Set(vercelModelIds)),
      isValidOpenRouterModelId: jest.fn(
        async (modelId: string) =>
          legacyOpenRouterAliases.has(modelId) || openRouterModelIds.includes(modelId)
      ),
    }));
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => {
      const actual = jest.requireActual<typeof MapModelIdToVercelModule>(
        '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
      );
      const overrideMap = new Map(overrides);
      return {
        ...actual,
        getVercelModelIdOverrides: jest.fn(async () => overrideMap),
        mapModelIdToVercel: jest.fn(async (modelId: string) =>
          actual.mapResolvedModelIdToVercel(aliases[modelId] ?? modelId, overrideMap)
        ),
      };
    });
    return (await import('@kilocode/web-shared/lib/ai-gateway/providers/vercel'))
      .isValidVercelModelId;
  }

  it('accepts a model whose Vercel id is listed and rejects one that is not', async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: ['alibaba/qwen3.5-flash'],
    });

    await expect(isValidVercelModelId('qwen/qwen3.5-flash')).resolves.toBe(true);
    await expect(isValidVercelModelId('vendor/unknown-model')).resolves.toBe(false);
  });

  it.each([
    ['zai/glm-5', 'z-ai/glm-5'],
    ['alibaba/qwen3-coder', 'qwen/qwen3-coder'],
    ['mistral/mistral-small', 'mistralai/mistral-small'],
    ['spacexai/grok-5', 'x-ai/grok-5'],
    ['bytedance/seed-2.0', 'bytedance-seed/seed-2.0'],
  ])('rejects the raw Vercel id %s but accepts %s', async (vercelId, kiloId) => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: [vercelId],
      openRouterModelIds: [kiloId],
    });

    await expect(isValidVercelModelId(vercelId)).resolves.toBe(false);
    await expect(isValidVercelModelId(kiloId)).resolves.toBe(true);
  });

  it('accepts a Vercel-only model under its OpenRouter-style id only', async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: ['zai/glm-vercel-only', 'reflection/beta'],
    });

    await expect(isValidVercelModelId('z-ai/glm-vercel-only')).resolves.toBe(true);
    await expect(isValidVercelModelId('zai/glm-vercel-only')).resolves.toBe(false);
    await expect(isValidVercelModelId('reflection/beta')).resolves.toBe(true);
  });

  it('rejects the Vercel id an override maps to', async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: ['meta/muse-wonder-1.0'],
      openRouterModelIds: ['meta/muse-wonder'],
      overrides: [['meta/muse-wonder', 'meta/muse-wonder-1.0']],
    });

    await expect(isValidVercelModelId('meta/muse-wonder')).resolves.toBe(true);
    await expect(isValidVercelModelId('meta/muse-wonder-1.0')).resolves.toBe(false);
  });

  it('accepts every Kilo id that shares a Vercel model', async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: ['anthropic/claude-haiku-4.5'],
      openRouterModelIds: ['anthropic/claude-haiku-4.5'],
      overrides: [['anthropic/claude-haiku-4-5', 'anthropic/claude-haiku-4.5']],
    });

    await expect(isValidVercelModelId('anthropic/claude-haiku-4-5')).resolves.toBe(true);
    await expect(isValidVercelModelId('anthropic/claude-haiku-4.5')).resolves.toBe(true);
  });

  it.each(['zai/glm-5.3', 'zai/glm-5.3-flash'])(
    'accepts the retained legacy alias %s that uses the Vercel spelling',
    async modelId => {
      const isValidVercelModelId = await loadIsValidVercelModelId({ vercelModelIds: [modelId] });

      await expect(isValidVercelModelId(modelId)).resolves.toBe(true);
    }
  );

  it('accepts a retained legacy alias that an override also targets', async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: ['nvidia/nemotron-3.5-lightning-free'],
      openRouterModelIds: ['nvidia/nemotron-3.5-lightning:free'],
      overrides: [['nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3.5-lightning-free']],
    });

    await expect(isValidVercelModelId('nvidia/nemotron-3.5-lightning:free')).resolves.toBe(true);
    await expect(isValidVercelModelId('nvidia/nemotron-3.5-lightning-free')).resolves.toBe(true);
  });

  it('accepts a latest alias that resolves to a model Vercel serves', async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({
      vercelModelIds: ['zai/glm-5'],
      openRouterModelIds: ['~z-ai/glm-latest', 'z-ai/glm-5'],
      aliases: { '~z-ai/glm-latest': 'z-ai/glm-5' },
    });

    await expect(isValidVercelModelId('~z-ai/glm-latest')).resolves.toBe(true);
  });

  it("assumes a model is valid while Vercel's model list is unavailable", async () => {
    const isValidVercelModelId = await loadIsValidVercelModelId({ vercelModelIds: [] });

    await expect(isValidVercelModelId('vendor/unknown-model')).resolves.toBe(true);
    await expect(isValidVercelModelId('zai/glm-5')).resolves.toBe(true);
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
  const azureCredentials = JSON.stringify({
    apiKey: 'azure-api-key',
    resourceName: 'example-resource',
    modelMappings: [
      {
        gatewayModelSlug: 'openai/gpt-5.4-nano',
        customModelId: 'custom-gpt-5.4-nano',
      },
    ],
  });
  const vertexCredentials = JSON.stringify({
    project: 'example-project',
    location: 'us-east5',
    googleCredentials: {
      privateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
      clientEmail: 'gateway@example-project.iam.gserviceaccount.com',
    },
  });

  it.each([
    { sort: 'throughput', expected: 'tps' },
    { sort: 'future-sort', expected: undefined },
  ])('converts sort $sort without changing BYOK pinning', async ({ sort, expected }) => {
    const request = byokRequest([]);
    request.body.provider = { sort: sort as OpenRouterProviderConfig['sort'] };

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [
        { decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' },
        { decryptedAPIKey: bedrockCredentials, providerId: 'bedrock' },
      ],
      null
    );

    expect(request.body.providerOptions?.gateway).toEqual({
      sort: expected,
      only: ['anthropic', 'bedrock'],
      byok: {
        anthropic: [{ apiKey: 'sk-anthropic' }],
        bedrock: [{ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' }],
      },
      sessionAffinity: true,
    });
    expect(request.body.provider).toBeUndefined();
  });

  it('keeps the same gateway options on BYOK and managed paths for identical provider preferences', async () => {
    const provider = {
      sort: 'latency' as const,
      zdr: true,
      data_collection: 'deny' as const,
    };
    const byok = byokRequest([]);
    byok.body.provider = { ...provider };
    const managed: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        provider: { ...provider },
      },
    };

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      byok,
      [{ decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' }],
      null
    );
    const managedOptions = convertProviderOptions(managed, null).gateway;
    if (!managedOptions) {
      throw new Error('convertProviderOptions did not produce managed gateway options');
    }

    const gatewayOptions = byok.body.providerOptions?.gateway;
    if (!gatewayOptions) {
      throw new Error('applyVercelSettings did not produce BYOK gateway options');
    }
    const byokCredentials = gatewayOptions.byok;
    expect(byokCredentials).toEqual({ anthropic: [{ apiKey: 'sk-anthropic' }] });
    for (const [key, value] of Object.entries(managedOptions)) {
      if (key === 'only' || key === 'order' || key === 'sessionId') {
        continue;
      }
      expect(gatewayOptions[key as keyof typeof gatewayOptions]).toEqual(value);
    }
    expect(gatewayOptions.zeroDataRetention).toBe(true);
    expect(gatewayOptions.disallowPromptTraining).toBe(true);
  });

  it('sets zeroDataRetention and disallowPromptTraining in the BYOK gateway options', async () => {
    const request = byokRequest([]);
    request.body.provider = { zdr: true, data_collection: 'deny' };

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [
        { decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' },
        { decryptedAPIKey: bedrockCredentials, providerId: 'bedrock' },
      ],
      null
    );

    expect(request.body.providerOptions?.gateway).toMatchObject({
      zeroDataRetention: true,
      disallowPromptTraining: true,
      only: ['anthropic', 'bedrock'],
      byok: {
        anthropic: [{ apiKey: 'sk-anthropic' }],
        bedrock: [{ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' }],
      },
    });
    expect(request.body.provider).toBeUndefined();
  });

  it('leaves zeroDataRetention and disallowPromptTraining unset when the provider settings omit them', async () => {
    const request = byokRequest([]);
    request.body.provider = { data_collection: 'allow' };

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.zeroDataRetention).toBeUndefined();
    expect(request.body.providerOptions?.gateway?.disallowPromptTraining).toBeUndefined();
  });

  it('drops a BYOK provider the caller ignored when another serving provider remains', async () => {
    const request = byokRequest(['anthropic']);

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [
        { decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' },
        { decryptedAPIKey: bedrockCredentials, providerId: 'bedrock' },
      ],
      null
    );

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

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      anthropic: [{ apiKey: 'sk-anthropic' }],
    });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['anthropic']);
  });

  it('does not add managed Friendli credentials to user BYOK settings', async () => {
    process.env.FRIENDLI_API_KEY = 'friendli-managed-key';
    const request = byokRequest([]);

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      anthropic: [{ apiKey: 'sk-anthropic' }],
    });
  });

  it.each<GatewayRequest>([
    {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    },
    {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
      },
    },
    {
      kind: 'responses',
      body: { model: 'anthropic/claude-sonnet-4.5', input: 'hello' },
    },
  ])('forwards Bedrock API key credentials for $kind', async request => {
    const credentials = { apiKey: 'bedrock-api-key', region: 'eu-west-1' };
    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: JSON.stringify(credentials), providerId: 'bedrock' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({ bedrock: [credentials] });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['bedrock']);
  });

  it('retains a Bedrock API key when the caller ignores its only BYOK provider', async () => {
    const request = byokRequest(['amazon-bedrock']);
    const credentials = { apiKey: 'bedrock-api-key', region: 'us-east-1' };
    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: JSON.stringify(credentials), providerId: 'bedrock' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({ bedrock: [credentials] });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['bedrock']);
  });

  it('forwards structured Azure credentials', async () => {
    const request = byokRequest([]);

    await applyVercelSettings(
      'openai/gpt-5.4-nano',
      request,
      [{ decryptedAPIKey: azureCredentials, providerId: 'azure' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      azure: [JSON.parse(azureCredentials)],
    });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['azure']);
  });

  it('rejects malformed Azure credentials without including credential contents', async () => {
    await expect(
      applyVercelSettings(
        'openai/gpt-5.4-nano',
        byokRequest([]),
        [{ decryptedAPIKey: '{"apiKey":"secret"}', providerId: 'azure' }],
        null
      )
    ).rejects.toEqual(new Error('Failed to parse Azure credentials'));
  });

  it.each([
    'bedrock-secret',
    '{"apiKey":"bedrock-secret"',
    '{"apiKey":"bedrock-secret"}',
    '{"apiKey":"bedrock-secret","region":"us-east-1","accessKeyId":"AKIAEXAMPLE","secretAccessKey":"secret"}',
  ])('rejects malformed Bedrock credentials without exposing secrets: %s', async credentials => {
    await expect(
      applyVercelSettings(
        'anthropic/claude-sonnet-4.5',
        byokRequest([]),
        [{ decryptedAPIKey: credentials, providerId: 'bedrock' }],
        null
      )
    ).rejects.toEqual(new Error('Failed to parse AWS credentials'));
  });

  it('uses one Vertex credential key for Anthropic models served by Vertex', async () => {
    const request = byokRequest([]);

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: vertexCredentials, providerId: 'vertex' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      vertex: [
        {
          project: 'example-project',
          location: 'us-east5',
          googleCredentials: {
            privateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
            clientEmail: 'gateway@example-project.iam.gserviceaccount.com',
          },
        },
      ],
    });
    expect(request.body.providerOptions?.gateway?.only).toEqual(['vertex']);
  });

  it('rejects malformed Vertex credentials without including credential contents', async () => {
    const request = byokRequest([]);

    await expect(
      applyVercelSettings(
        'google/gemini-2.5-flash-lite',
        request,
        [{ decryptedAPIKey: '{"privateKey":"secret"}', providerId: 'vertex' }],
        null
      )
    ).rejects.toThrow('Failed to parse Google Vertex credentials');
  });

  it('pins BYOK inference to the data region', async () => {
    const request = byokRequest([]);

    await applyVercelSettings(
      'openai/gpt-5',
      request,
      [{ decryptedAPIKey: 'sk-user-openai', providerId: 'openai' }],
      'eu'
    );

    expect(request.body.providerOptions?.gateway).toMatchObject({
      only: ['openai'],
      inferenceRegion: { scope: 'zone', geoRegion: 'eu' },
    });
  });

  it('forwards user OpenAI BYOK credentials', async () => {
    const request = byokRequest([]);

    await applyVercelSettings(
      'openai/gpt-5',
      request,
      [{ decryptedAPIKey: 'sk-user-openai', providerId: 'openai' }],
      null
    );

    expect(request.body.providerOptions?.gateway?.byok).toEqual({
      openai: [{ apiKey: 'sk-user-openai' }],
    });
  });

  it('pins Cohere requests to the provider and forwards the user API key', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'cohere/command-a',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    await applyVercelSettings(
      'cohere/command-a',
      request,
      [{ decryptedAPIKey: 'cohere-user-key', providerId: 'cohere' }],
      null
    );

    expect(request.body.model).toBe('cohere/command-a');
    expect(request.body.providerOptions?.gateway).toMatchObject({
      only: ['cohere'],
      byok: { cohere: [{ apiKey: 'cohere-user-key' }] },
    });
  });
});

describe('applyVercelSettings managed requests', () => {
  async function applyManagedVercelSettings(
    requestedModel: string,
    request: GatewayRequest,
    vercelInferenceProviders: string[] | null = ['openai'],
    dataRegion: OrganizationDataRegion | null = null
  ) {
    jest.resetModules();
    const getVercelInferenceProvidersMock = jest
      .fn<(modelId: string) => Promise<string[] | null>>()
      .mockResolvedValue(vercelInferenceProviders);
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getCachedVercelInferenceProviderIdsForModel: getVercelInferenceProvidersMock,
      getVercelModelsFromDatabase: jest.fn(),
    }));
    const { applyVercelSettings: applyManagedSettings } =
      await import('@kilocode/web-shared/lib/ai-gateway/providers/vercel');

    await applyManagedSettings(requestedModel, request, null, dataRegion);
    return getVercelInferenceProvidersMock;
  }

  it.each(OrganizationDataRegionSchema.options)(
    'pins managed inference to the %s data region',
    async region => {
      const request = managedRequest({ only: ['openai'] });

      await applyManagedVercelSettings('moonshotai/kimi-k3', request, ['openai'], region);

      expect(request.body.providerOptions?.gateway).toMatchObject({
        only: ['openai'],
        inferenceRegion: { scope: 'zone', geoRegion: region },
      });
    }
  );

  it('leaves the region unset without a data region', async () => {
    const request = managedRequest();

    await applyManagedVercelSettings('moonshotai/kimi-k3', request);

    expect(request.body.providerOptions?.gateway?.inferenceRegion).toBeUndefined();
  });

  function managedRequest(provider?: GatewayRequest['body']['provider']): GatewayRequest {
    return {
      kind: 'chat_completions',
      body: {
        model: 'moonshotai/kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
        provider,
      },
    };
  }

  function managedRequestForApi(kind: GatewayRequest['kind'], model: string): GatewayRequest {
    const provider = { ignore: ['openai'] };
    if (kind === 'responses') {
      return { kind, body: { model, input: 'hello', provider } };
    }
    if (kind === 'messages') {
      return {
        kind,
        body: {
          model,
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hello' }],
          provider,
        },
      };
    }
    return {
      kind,
      body: { model, messages: [{ role: 'user', content: 'hello' }], provider },
    };
  }

  it.each(['chat_completions', 'messages', 'responses'] as const)(
    'converts provider.sort for managed %s requests',
    async kind => {
      const request = managedRequestForApi(kind, 'anthropic/claude-sonnet-4.5');
      request.body.provider = { sort: 'latency' };

      await applyManagedVercelSettings('anthropic/claude-sonnet-4.5', request, ['anthropic']);

      expect(request.body.providerOptions?.gateway?.sort).toBe('ttft');
      expect(request.body.provider).toBeUndefined();
    }
  );

  describe.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])('%s', modelId => {
    it.each(['chat_completions', 'messages', 'responses'] as const)(
      'preserves the model ID and honors provider preferences for %s requests',
      async kind => {
        const request = managedRequestForApi(kind, modelId);

        const getVercelInferenceProvidersMock = await applyManagedVercelSettings(modelId, request, [
          'minimax',
          'openai',
        ]);

        expect(request.body.model).toBe(modelId);
        expect(request.body.provider).toBeUndefined();
        expect(request.body.providerOptions?.gateway?.only).toEqual(['minimax']);
        expect(getVercelInferenceProvidersMock).toHaveBeenCalledWith(modelId);
      }
    );
  });

  it('does not add managed Friendli credentials from the environment', async () => {
    process.env.FRIENDLI_API_KEY = 'friendli-managed-key';
    const request = managedRequest();

    await applyManagedVercelSettings('moonshotai/kimi-k3', request);

    expect(request.body.providerOptions?.gateway?.byok).toBeUndefined();
  });

  it('does not add managed OpenAI credentials from the environment', async () => {
    process.env.OPENAI_API_KEY = 'openai-managed-key';
    const request = managedRequest({ only: ['openai'] });

    await applyManagedVercelSettings('openai/gpt-5', request);

    expect(request.body.providerOptions?.gateway?.byok).toBeUndefined();
  });
});

describe('applyVercelSettings session affinity', () => {
  const conversationId = 'conversation-hash';

  function requestWithConversationId(
    kind: GatewayRequest['kind'],
    id: string | undefined
  ): GatewayRequest {
    const model = 'anthropic/claude-sonnet-4.5';
    const provider = { order: ['google-vertex', 'amazon-bedrock'] };
    if (kind === 'responses') {
      return { kind, body: { model, input: 'hello', provider, prompt_cache_key: id } };
    }
    if (kind === 'messages') {
      return {
        kind,
        body: {
          model,
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hello' }],
          provider,
          session_id: id,
        },
      };
    }
    return {
      kind,
      body: {
        model,
        messages: [{ role: 'user', content: 'hello' }],
        provider,
        prompt_cache_key: id,
      },
    };
  }

  async function loadApplyVercelSettings() {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getCachedVercelInferenceProviderIdsForModel: jest.fn(async () => ['vertex', 'bedrock']),
      getVercelModelsFromDatabase: jest.fn(),
    }));
    return (await import('@kilocode/web-shared/lib/ai-gateway/providers/vercel'))
      .applyVercelSettings;
  }

  const kinds = ['chat_completions', 'messages', 'responses'] as const;

  it.each(kinds)('sends the conversation ID for managed %s requests', async kind => {
    const applySettings = await loadApplyVercelSettings();
    const request = requestWithConversationId(kind, conversationId);

    await applySettings('anthropic/claude-sonnet-4.5', request, null, null);

    expect(request.body.providerOptions?.gateway).toMatchObject({
      sessionId: conversationId,
      sessionAffinity: true,
      order: ['vertex', 'bedrock'],
    });
  });

  it.each(kinds)('sends the conversation ID for BYOK %s requests', async kind => {
    const request = requestWithConversationId(kind, conversationId);

    await applyVercelSettings(
      'anthropic/claude-sonnet-4.5',
      request,
      [{ decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' }],
      null
    );

    expect(request.body.providerOptions?.gateway).toMatchObject({
      sessionId: conversationId,
      sessionAffinity: true,
    });
  });

  it.each(kinds)('leaves sessionId unset without a conversation ID for %s', async kind => {
    const applySettings = await loadApplyVercelSettings();
    const managed = requestWithConversationId(kind, undefined);
    const byok = requestWithConversationId(kind, '');

    await applySettings('anthropic/claude-sonnet-4.5', managed, null, null);
    await applySettings(
      'anthropic/claude-sonnet-4.5',
      byok,
      [{ decryptedAPIKey: 'sk-anthropic', providerId: 'anthropic' }],
      null
    );

    for (const request of [managed, byok]) {
      expect(request.body.providerOptions?.gateway?.sessionAffinity).toBe(true);
      expect(request.body.providerOptions?.gateway).not.toHaveProperty('sessionId');
    }
  });
});

describe('isVercelRoutingOptOut', () => {
  it('only opts out exact model ID matches', () => {
    const optOutModels = new Set(['moonshotai/kimi-k3']);

    expect(isVercelRoutingOptOut('moonshotai/kimi-k3', optOutModels)).toBe(true);
    expect(isVercelRoutingOptOut('moonshotai/kimi-k3-fast', optOutModels)).toBe(false);
  });
});

describe('getNonChatGatewayOptions', () => {
  async function loadGetOptions(vercelInferenceProviders: string[] | null) {
    jest.resetModules();
    jest.doMock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
      getCachedVercelInferenceProviderIdsForModel: jest.fn(async () => vercelInferenceProviders),
      getVercelModelsFromDatabase: jest.fn(),
    }));
    return (await import('@kilocode/web-shared/lib/ai-gateway/providers/vercel'))
      .getNonChatGatewayOptions;
  }

  it("applies the request's ignore list to Kilo's route", async () => {
    const getOptions = await loadGetOptions(['openai', 'azure']);

    await expect(
      getOptions({
        vercelModelId: 'openai/text-embedding-3-small',
        userByok: null,
        provider: { ignore: ['openai'], order: ['azure'] },
        dataRegion: 'eu',
      })
    ).resolves.toEqual({
      kind: 'routable',
      gateway: {
        only: ['azure'],
        order: ['azure'],
        zeroDataRetention: undefined,
        disallowPromptTraining: undefined,
        inferenceRegion: { scope: 'zone', geoRegion: 'eu' },
      },
    });
  });

  it("translates TypeSafe's OpenRouter slug in the provider allow-list", async () => {
    const getOptions = await loadGetOptions(['typesafe-ai', 'digitalocean']);

    await expect(
      getOptions({
        vercelModelId: 'typesafe-ai/jev',
        userByok: null,
        provider: { only: ['typesafe'] },
        dataRegion: null,
      })
    ).resolves.toMatchObject({ kind: 'routable', gateway: { only: ['typesafe-ai'] } });
  });

  it('drops an ignored provider key unless it is the last one', async () => {
    const getOptions = await loadGetOptions(null);
    const userByok = [
      { decryptedAPIKey: 'sk-openai', providerId: 'openai' },
      { decryptedAPIKey: 'sk-mistral', providerId: 'mistral' },
    ] as const;

    const some = await getOptions({
      vercelModelId: 'openai/text-embedding-3-small',
      userByok: [...userByok],
      provider: { ignore: ['openai'] },
      dataRegion: 'eu',
    });
    expect(some).toMatchObject({ kind: 'routable', gateway: { only: ['mistral'] } });
    expect(some).not.toHaveProperty('gateway.inferenceRegion');

    const all = await getOptions({
      vercelModelId: 'openai/text-embedding-3-small',
      userByok: [userByok[0]],
      provider: { ignore: ['openai'] },
      dataRegion: null,
    });
    expect(all).toMatchObject({ kind: 'routable', gateway: { only: ['openai'] } });
  });

  it("rejects Kilo's route when the ignore list excludes every provider of the model", async () => {
    const getOptions = await loadGetOptions(['azure', 'openai']);

    await expect(
      getOptions({
        vercelModelId: 'openai/text-embedding-3-small',
        userByok: null,
        provider: { ignore: ['openai', 'azure'] },
        dataRegion: null,
      })
    ).resolves.toEqual({ kind: 'no-eligible-provider', providers: ['azure', 'openai'] });
  });

  it('matches OpenRouter slugs in the ignore list against Vercel provider ids', async () => {
    const getOptions = await loadGetOptions(['vertex', 'vertexAnthropic', 'bedrock']);

    await expect(
      getOptions({
        vercelModelId: 'anthropic/claude-sonnet-4.5',
        userByok: null,
        provider: { ignore: ['google-vertex', 'amazon-bedrock'] },
        dataRegion: null,
      })
    ).resolves.toEqual({ kind: 'no-eligible-provider', providers: ['vertex', 'bedrock'] });
  });

  it.each([
    ['without an ignore list', { only: ['mistral'] }],
    ['with an ignore list', { only: ['mistral'], ignore: ['azure'] }],
  ])(
    "rejects Kilo's route when the allow-list names no provider of the model, %s",
    async (_, provider) => {
      const getOptions = await loadGetOptions(['azure', 'openai']);

      await expect(
        getOptions({
          vercelModelId: 'openai/text-embedding-3-small',
          userByok: null,
          provider,
          dataRegion: null,
        })
      ).resolves.toEqual({ kind: 'no-eligible-provider', providers: ['azure', 'openai'] });
    }
  );

  it('rejects an empty allow-list even without provider data', async () => {
    const getOptions = await loadGetOptions(null);

    await expect(
      getOptions({
        vercelModelId: 'openai/text-embedding-3-small',
        userByok: null,
        provider: { only: [] },
        dataRegion: null,
      })
    ).resolves.toEqual({ kind: 'no-eligible-provider', providers: [] });
    await expect(
      getOptions({
        vercelModelId: 'openai/text-embedding-3-small',
        userByok: null,
        provider: { only: ['openai'], ignore: ['openai'] },
        dataRegion: null,
      })
    ).resolves.toEqual({ kind: 'no-eligible-provider', providers: [] });
  });

  it('keeps an allow-list that names a provider of the model', async () => {
    const getOptions = await loadGetOptions(['azure', 'openai']);

    await expect(
      getOptions({
        vercelModelId: 'openai/text-embedding-3-small',
        userByok: null,
        provider: { only: ['openai', 'mistral'] },
        dataRegion: null,
      })
    ).resolves.toMatchObject({ kind: 'routable', gateway: { only: ['openai', 'mistral'] } });
  });

  it("keeps the last provider key even when the request's provider settings exclude it", async () => {
    const getOptions = await loadGetOptions(['azure', 'openai']);

    await expect(
      getOptions({
        vercelModelId: 'openai/text-embedding-3-small',
        userByok: [{ decryptedAPIKey: 'sk-openai', providerId: 'openai' }],
        provider: { ignore: ['openai', 'azure'] },
        dataRegion: null,
      })
    ).resolves.toMatchObject({ kind: 'routable', gateway: { only: ['openai'] } });
  });
});
