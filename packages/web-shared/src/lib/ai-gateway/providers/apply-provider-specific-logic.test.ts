import { describe, expect, it } from '@jest/globals';
import {
  createUserVercelAiGatewayProvider,
  VERCEL_AI_GATEWAY,
} from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { applyVercelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  applyPreferredProvider,
  applyProviderSpecificLogic,
  applyReasoningDetailsTransform,
  getIgnoredProviders,
  removeModelsFallback,
  removeUnsupportedRequestServiceTier,
  withIgnoredProviders,
} from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  ReasoningDetailsTransform,
  type BYOKResult,
  type Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { gemma_4_26b_a4b_it_free_model } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';
import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { getCustomPricing } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';

function customPricingFor(model: string) {
  return getCustomPricing(TEST_CUSTOM_PRICING_CONFIG, model);
}

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  applyVercelSettings: jest.fn(),
}));

const USER_GATEWAY_TEST_MODEL = 'vendor/user-gateway-test-model';
const USER_GATEWAY_TEST_ORDER = ['google-vertex', 'amazon-bedrock'];

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn(async () => ({
    rules: [
      { includes: ['user-gateway-test-model'], providers: ['google-vertex', 'amazon-bedrock'] },
    ],
  })),
}));

function makeRequest(
  model: string,
  models?: string[]
): Extract<GatewayRequest, { kind: 'chat_completions' }> {
  return {
    kind: 'chat_completions',
    body: {
      model,
      models,
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

function makeProvider(responseTransforms: Provider['responseTransforms']): Provider {
  return {
    id: 'openrouter',
    apiUrl: 'https://example.com/v1',
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: 'test-key',
    apiKeyHeader: null,
    supportedChatApis: ['chat_completions'],
    responseTransforms,
    async transformRequest() {},
  };
}

function makeMessagesRequest(model: string): Extract<GatewayRequest, { kind: 'messages' }> {
  return {
    kind: 'messages',
    body: {
      model,
      max_tokens: 2_048,
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

describe('removeUnsupportedRequestServiceTier', () => {
  it.each([
    {
      model: 'google/gemini-3.8-flash',
      reason: 'non-fallback custom pricing',
    },
    {
      model: gemma_4_26b_a4b_it_free_model.public_id,
      reason: 'Kilo-exclusive model',
    },
  ])('removes and logs the request-level tier for $reason', ({ model, reason }) => {
    const request = makeRequest(model);
    request.body.service_tier = 'priority';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    removeUnsupportedRequestServiceTier(model, request, customPricingFor(model));

    expect(request.body.service_tier).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[applyProviderSpecificLogic] Removed unsupported request-level service tier',
      {
        model,
        requestKind: 'chat_completions',
        serviceTier: 'priority',
        reason,
      }
    );
    warn.mockRestore();
  });

  it.each(['auto', 'default', 'flex', 'priority', 'scale'] as const)(
    'records the recognized tier verbatim (%s)',
    tier => {
      const model = 'google/gemini-3.8-flash';
      const request = makeRequest(model);
      request.body.service_tier = tier;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      removeUnsupportedRequestServiceTier(model, request, customPricingFor(model));

      expect(request.body.service_tier).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[applyProviderSpecificLogic] Removed unsupported request-level service tier',
        expect.objectContaining({ serviceTier: tier })
      );
      warn.mockRestore();
    }
  );

  it.each(['unrecognized-tier', 'constructor', '__proto__', 42, null] as const)(
    'records only a recognized tier value (%s)',
    tier => {
      const model = 'google/gemini-3.8-flash';
      const request = makeRequest(model);
      request.body.service_tier = tier as unknown as typeof request.body.service_tier;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      removeUnsupportedRequestServiceTier(model, request, customPricingFor(model));

      expect(request.body.service_tier).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[applyProviderSpecificLogic] Removed unsupported request-level service tier',
        {
          model,
          requestKind: 'chat_completions',
          serviceTier: 'unrecognized',
          reason: 'non-fallback custom pricing',
        }
      );
      warn.mockRestore();
    }
  );

  it.each(['moonshotai/kimi-k3', 'vendor/standard-model'])(
    'preserves the request-level tier for %s',
    model => {
      const request = makeRequest(model);
      request.body.service_tier = 'priority';

      removeUnsupportedRequestServiceTier(model, request, customPricingFor(model));

      expect(request.body.service_tier).toBe('priority');
    }
  );
});

describe('applyProviderSpecificLogic JSON ref field sanitization', () => {
  async function applyToToolResult(model: string, content: string) {
    const request = makeRequest(model);
    request.body.messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content },
    ];

    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );

    return request.body.messages.find(message => message.role === 'tool')?.content;
  }

  it('sanitizes JSON ref fields for Gemini models', async () => {
    const content = await applyToToolResult(
      'google/gemini-3.1-pro-preview:free',
      '{"$ref":"#/$defs/result"}'
    );

    expect(content).toBe('{"_ref":"#/$defs/result"}');
  });

  it('preserves JSON ref fields for non-Gemini models', async () => {
    const content = await applyToToolResult('vendor/model:free', '{"$ref":"#/$defs/result"}');

    expect(content).toBe('{"$ref":"#/$defs/result"}');
  });
});

describe('applyProviderSpecificLogic recursive tool schemas', () => {
  async function applyToToolParameters(model: string) {
    const request: Extract<GatewayRequest, { kind: 'responses' }> = {
      kind: 'responses',
      body: {
        model,
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'filter',
            strict: false,
            parameters: {
              type: 'object',
              properties: { filters: { $ref: '#/$defs/filters' } },
              $defs: {
                filters: { type: 'array', items: { $ref: '#/$defs/filters' } },
              },
            },
          },
        ],
      },
    };

    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );

    const tool = request.body.tools?.[0];
    return tool?.type === 'function' ? tool.parameters : undefined;
  }

  it('removes recursive refs for Muse models', async () => {
    const parameters = await applyToToolParameters('meta/muse-spark-1.3');

    expect(parameters?.$defs).toEqual({ filters: { type: 'array', items: { type: 'array' } } });
  });

  it('preserves recursive refs for other models', async () => {
    const parameters = await applyToToolParameters('vendor/model');

    expect(parameters?.$defs).toEqual({
      filters: { type: 'array', items: { $ref: '#/$defs/filters' } },
    });
  });
});

describe('applyProviderSpecificLogic top-level tool schema combinators', () => {
  async function applyToTool(model: string) {
    const request = makeMessagesRequest(model);
    request.body.tools = [
      {
        name: 'nteract_create_cell',
        description: 'Create a cell.',
        input_schema: {
          type: 'object',
          properties: { notebook_id: { type: ['string', 'null'] } },
          oneOf: [{ required: ['notebook_id'] }],
        },
      },
    ];

    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );

    return request.body.tools[0];
  }

  it('removes top-level combinators for Claude models', async () => {
    const tool = await applyToTool('anthropic/claude-opus-5.5');

    expect(tool).toEqual({
      name: 'nteract_create_cell',
      description:
        'Create a cell.\n\nThe input must also match exactly one of these JSON schemas: [{"required":["notebook_id"]}]',
      input_schema: {
        type: 'object',
        properties: { notebook_id: { type: ['string', 'null'] } },
        required: ['notebook_id'],
      },
    });
  });

  it('preserves top-level combinators for other models', async () => {
    const tool = await applyToTool('vendor/model');

    expect(tool).toEqual({
      name: 'nteract_create_cell',
      description: 'Create a cell.',
      input_schema: {
        type: 'object',
        properties: { notebook_id: { type: ['string', 'null'] } },
        oneOf: [{ required: ['notebook_id'] }],
      },
    });
  });
});

describe('applyProviderSpecificLogic untyped tool schema enums', () => {
  async function applyToToolParameters(model: string) {
    const request: Extract<GatewayRequest, { kind: 'chat_completions' }> = {
      kind: 'chat_completions',
      body: {
        model,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'edit_page',
              parameters: {
                type: 'object',
                properties: { op: { enum: ['set_title', 'delete_block'] } },
              },
            },
          },
        ],
      },
    };

    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );

    const tool = request.body.tools?.[0];
    return tool?.type === 'function' ? tool.function.parameters?.properties : undefined;
  }

  it('adds enum types for Kimi models', async () => {
    const properties = await applyToToolParameters('moonshotai/kimi-k3.1-pro');

    expect(properties).toEqual({ op: { type: 'string', enum: ['set_title', 'delete_block'] } });
  });

  it('preserves untyped enums for other models', async () => {
    const properties = await applyToToolParameters('vendor/model');

    expect(properties).toEqual({ op: { enum: ['set_title', 'delete_block'] } });
  });
});

describe('applyReasoningDetailsTransform', () => {
  function makeReasoningRequest(): Extract<GatewayRequest, { kind: 'chat_completions' }> {
    return {
      kind: 'chat_completions',
      body: {
        model: 'vendor/model',
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: 'hi',
            reasoning_details: [
              { type: 'reasoning.text' as const, text: 'thinking ', signature: null },
              { type: 'reasoning.encrypted' as const, data: 'opaque-blob' },
              { type: 'reasoning.text' as const, text: 'hard' },
            ],
          } as never,
        ],
      },
    };
  }

  it('folds reasoning_details into reasoning_content when the transform is enabled', () => {
    const request = makeReasoningRequest();

    applyReasoningDetailsTransform(
      makeProvider(ReasoningDetailsTransform.ReasoningContent),
      request
    );

    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    expect('reasoning_details' in assistant).toBe(false);
    expect(assistant.reasoning_content).toBe('thinking hard');
  });

  it('replaces the reasoning object with reasoning_effort for reasoning-content upstreams', () => {
    const request = makeReasoningRequest();
    request.body.reasoning = { effort: 'high', enabled: true };

    applyReasoningDetailsTransform(
      makeProvider(ReasoningDetailsTransform.ReasoningContent),
      request
    );

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body.reasoning_effort).toBe('high');
  });

  it('folds reasoning_details into a reasoning string for reasoning upstreams', () => {
    const request = makeReasoningRequest();
    request.body.reasoning = { effort: 'high', enabled: true };

    applyReasoningDetailsTransform(makeProvider(ReasoningDetailsTransform.Reasoning), request);

    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    expect('reasoning_details' in assistant).toBe(false);
    expect(assistant).not.toHaveProperty('reasoning_content');
    expect(assistant.reasoning).toBe('thinking hard');
    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body.reasoning_effort).toBe('high');
  });

  it('keeps a legacy reasoning string for reasoning upstreams without reasoning_details', () => {
    const request = makeReasoningRequest();
    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    delete assistant.reasoning_details;
    assistant.reasoning = 'legacy thinking';

    applyReasoningDetailsTransform(makeProvider(ReasoningDetailsTransform.Reasoning), request);

    expect(assistant.reasoning).toBe('legacy thinking');
    expect(assistant).not.toHaveProperty('reasoning_content');
  });

  it('keeps the reasoning object without a transform', () => {
    const request = makeReasoningRequest();
    request.body.reasoning = { effort: 'high' };

    applyReasoningDetailsTransform(makeProvider(null), request);

    expect(request.body.reasoning).toEqual({ effort: 'high' });
    expect(request.body).not.toHaveProperty('reasoning_effort');
  });

  it('drops the legacy reasoning string next to reasoning_details', () => {
    const request = makeReasoningRequest();
    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    assistant.reasoning = 'thinking hard';

    applyReasoningDetailsTransform(
      makeProvider(ReasoningDetailsTransform.ReasoningContent),
      request
    );

    expect(assistant).not.toHaveProperty('reasoning');
    expect(assistant.reasoning_content).toBe('thinking hard');
  });

  it('folds a legacy reasoning string into reasoning_content without reasoning_details', () => {
    const request = makeReasoningRequest();
    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    delete assistant.reasoning_details;
    assistant.reasoning = 'legacy thinking';

    applyReasoningDetailsTransform(
      makeProvider(ReasoningDetailsTransform.ReasoningContent),
      request
    );

    expect(assistant).not.toHaveProperty('reasoning');
    expect(assistant.reasoning_content).toBe('legacy thinking');
  });

  it('keeps existing reasoning_content over a legacy reasoning string', () => {
    const request = makeReasoningRequest();
    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    delete assistant.reasoning_details;
    assistant.reasoning = 'legacy thinking';
    assistant.reasoning_content = 'upstream thinking';

    applyReasoningDetailsTransform(
      makeProvider(ReasoningDetailsTransform.ReasoningContent),
      request
    );

    expect(assistant).not.toHaveProperty('reasoning');
    expect(assistant.reasoning_content).toBe('upstream thinking');
  });

  it('drops the legacy reasoning string for Gemini', () => {
    const request = makeReasoningRequest();
    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    assistant.reasoning = 'thinking hard';

    applyReasoningDetailsTransform(makeProvider(ReasoningDetailsTransform.GeminiThought), request);

    expect(assistant).not.toHaveProperty('reasoning');
    expect(assistant).not.toHaveProperty('reasoning_details');
  });

  it('leaves reasoning_details untouched without a transform', () => {
    const request = makeReasoningRequest();

    applyReasoningDetailsTransform(makeProvider(null), request);

    const assistant = request.body.messages[1] as unknown as Record<string, unknown>;
    expect(assistant.reasoning_details).toBeDefined();
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it.each([
    [false, { thought_tag_marker: 'think' }],
    [undefined, { thought_tag_marker: 'think' }],
    [true, {}],
  ])(
    'asks Gemini for thought tags only without streaming (stream: %s)',
    (stream, expectedMarker) => {
      const request = makeReasoningRequest();
      request.body.stream = stream;
      request.body.reasoning_effort = 'high';

      applyReasoningDetailsTransform(
        makeProvider(ReasoningDetailsTransform.GeminiThought),
        request
      );

      expect((request.body as { google?: unknown }).google).toEqual({
        thinking_config: { thinking_level: 'high', include_thoughts: true },
        ...expectedMarker,
      });
    }
  );

  it('maps Gemini encrypted details to matching tool-call signatures', () => {
    const request: Extract<GatewayRequest, { kind: 'chat_completions' }> = {
      kind: 'chat_completions',
      body: {
        model: 'vendor/model',
        reasoning_effort: 'high',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
            reasoning_details: [
              {
                type: 'reasoning.encrypted',
                data: 'opaque-signature',
                id: 'call-1',
                format: 'google-gemini-v1',
              },
            ],
          } as never,
        ],
      },
    };

    applyReasoningDetailsTransform(makeProvider(ReasoningDetailsTransform.GeminiThought), request);

    expect(request.body).toMatchObject({
      google: { thinking_config: { thinking_level: 'high', include_thoughts: true } },
      messages: [
        {
          tool_calls: [
            {
              id: 'call-1',
              extra_content: { google: { thought_signature: 'opaque-signature' } },
            },
          ],
        },
      ],
    });
    expect(request.body).not.toHaveProperty('reasoning_effort');
    expect(request.body.messages[0]).not.toHaveProperty('reasoning_details');
  });

  it('keeps id-less Gemini signatures on the message when tool calls are present', () => {
    const request: Extract<GatewayRequest, { kind: 'chat_completions' }> = {
      kind: 'chat_completions',
      body: {
        model: 'vendor/model',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
            reasoning_details: [
              {
                type: 'reasoning.encrypted',
                data: 'message-signature',
                format: 'google-gemini-v1',
              },
              {
                type: 'reasoning.encrypted',
                data: 'tool-signature',
                id: 'call-1',
                format: 'google-gemini-v1',
              },
            ],
          } as never,
        ],
      },
    };

    applyReasoningDetailsTransform(makeProvider(ReasoningDetailsTransform.GeminiThought), request);

    expect(request.body.messages[0]).toMatchObject({
      extra_content: { google: { thought_signature: 'message-signature' } },
      tool_calls: [
        {
          id: 'call-1',
          extra_content: { google: { thought_signature: 'tool-signature' } },
        },
      ],
    });
  });

  it('does not touch Messages requests', () => {
    const request = makeMessagesRequest('vendor/model');

    applyReasoningDetailsTransform(
      makeProvider(ReasoningDetailsTransform.ReasoningContent),
      request
    );

    expect(request.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('removeModelsFallback', () => {
  it.each(['anthropic/claude-fable-5', 'anthropic/claude-opus-5', 'openai/gpt-4o'])(
    'removes and logs caller-provided fallbacks for %s',
    requestedModel => {
      const request = makeRequest(requestedModel, ['caller/fallback']);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      removeModelsFallback(requestedModel, request);

      expect(request.body.models).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[applyProviderSpecificLogic] Removed caller-provided fallback models',
        {
          model: requestedModel,
          requestKind: 'chat_completions',
          modelsPresent: true,
          modelsCount: 1,
          fallbacksPresent: false,
          fallbacksCount: null,
        }
      );
      warn.mockRestore();
    }
  );

  it.each([[[{ model: 'anthropic/claude-opus-4.6' }]], ['default']])(
    'removes and logs caller-provided Messages API fallbacks %j',
    fallbacks => {
      const model = 'thinkingmachines/inkling-small:free';
      const request = makeMessagesRequest(model);
      request.body.fallbacks = fallbacks;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      removeModelsFallback(model, request);

      expect(request.body).not.toHaveProperty('fallbacks');
      expect(warn).toHaveBeenCalledWith(
        '[applyProviderSpecificLogic] Removed caller-provided fallback models',
        {
          model,
          requestKind: 'messages',
          modelsPresent: false,
          modelsCount: null,
          fallbacksPresent: true,
          fallbacksCount: Array.isArray(fallbacks) ? fallbacks.length : null,
        }
      );
      warn.mockRestore();
    }
  );

  it.each([
    ['no fallback fields', {}],
    ['empty models', { models: [] }],
    ['null fallbacks', { fallbacks: null }],
    ['empty fallbacks', { fallbacks: [] }],
  ])('does not log when there is nothing to remove (%s)', (_, fields) => {
    const model = 'anthropic/claude-opus-5';
    const request = makeMessagesRequest(model);
    Object.assign(request.body, fields);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    removeModelsFallback(model, request);

    expect(request.body).not.toHaveProperty('models');
    expect(request.body).not.toHaveProperty('fallbacks');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes Messages API fallbacks before a free model request is sent upstream', async () => {
    const model = 'thinkingmachines/inkling-small:free';
    const request = makeMessagesRequest(model);
    request.body.fallbacks = [{ model: 'anthropic/claude-opus-4.6' }];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );

    expect(request.body).not.toHaveProperty('fallbacks');
    expect(warn).toHaveBeenCalledWith(
      '[applyProviderSpecificLogic] Removed caller-provided fallback models',
      expect.objectContaining({
        model,
        requestKind: 'messages',
        fallbacksPresent: true,
        fallbacksCount: 1,
      })
    );
    warn.mockRestore();
  });
});

describe('applyProviderSpecificLogic with a user gateway key', () => {
  const requestedModel = USER_GATEWAY_TEST_MODEL;

  async function apply(userByok: BYOKResult[] | null, provider = makeProvider(null)) {
    const request = makeRequest(requestedModel, ['caller/fallback']);
    await applyProviderSpecificLogic(
      provider,
      requestedModel,
      request,
      {},
      userByok,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      true
    );
    return request;
  }

  it('shapes a user Vercel AI Gateway key request like a managed Vercel request', async () => {
    const request = await apply(
      [{ providerId: 'vercel-ai-gateway', decryptedAPIKey: 'user-key' }],
      createUserVercelAiGatewayProvider('user-key')
    );

    expect(applyVercelSettings).toHaveBeenCalledWith(requestedModel, request, null);
  });

  it('passes inference provider keys to the Vercel settings', async () => {
    const userByok: BYOKResult[] = [{ providerId: 'anthropic', decryptedAPIKey: 'user-key' }];

    const request = await apply(userByok, VERCEL_AI_GATEWAY);

    expect(applyVercelSettings).toHaveBeenCalledWith(requestedModel, request, userByok);
  });

  it.each(['openrouter', 'vercel-ai-gateway'] as const)(
    'skips Kilo provider order for a %s key',
    async providerId => {
      const request = await apply([{ providerId, decryptedAPIKey: 'user-key' }]);

      expect(request.body.provider).toBeUndefined();
    }
  );

  it('keeps Kilo provider order on Kilo keys', async () => {
    const request = await apply(null);

    expect(request.body.provider).toEqual({ order: USER_GATEWAY_TEST_ORDER });
  });

  it.each([
    { providerId: 'openrouter', provider: makeProvider(null), tool: 'openrouter:web_search' },
    {
      providerId: 'vercel-ai-gateway',
      provider: createUserVercelAiGatewayProvider('user-key'),
      tool: 'vercel:perplexity_search',
    },
  ] as const)(
    'keeps paid server features for a $providerId key, which bills the user account',
    async ({ providerId, provider, tool }) => {
      const request = makeRequest(requestedModel);
      const serverFeatures = { plugins: [{ id: 'web' }], tools: [{ type: tool }] };
      Object.assign(request.body, structuredClone(serverFeatures));

      await applyProviderSpecificLogic(
        provider,
        requestedModel,
        request,
        {},
        [{ providerId, decryptedAPIKey: 'user-key' }],
        EmptyFraudDetectionHeaders,
        'user-1',
        null,
        null,
        null,
        true
      );

      expect(request.body).toMatchObject(serverFeatures);
    }
  );
});

describe('applyProviderSpecificLogic thinking block binding', () => {
  const model = 'anthropic/claude-opus-5.5';

  async function apply(provider: Provider) {
    const request = makeMessagesRequest(model);
    request.body.thinking = { type: 'adaptive' };
    const extraHeaders: Record<string, string> = {};
    await applyProviderSpecificLogic(
      provider,
      model,
      request,
      extraHeaders,
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );
    return { thinking: request.body.thinking, extraHeaders };
  }

  it.each([
    { name: 'Vercel', provider: VERCEL_AI_GATEWAY },
    { name: 'OpenRouter', provider: OPENROUTER },
  ])('drops mismatched thinking blocks on $name', async ({ provider }) => {
    const { thinking, extraHeaders } = await apply(provider);

    expect(thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(extraHeaders['anthropic-beta']).toBe(
      'fine-grained-tool-streaming-2025-05-14,thinking-binding-controls-2026-08-01'
    );
  });

  it('leaves upstreams without verified support untouched', async () => {
    const { thinking, extraHeaders } = await apply({ ...makeProvider(null), id: 'custom' });

    expect(thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(extraHeaders['anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14');
  });
});

describe('applyProviderSpecificLogic paid server features', () => {
  const fields = {
    plugins: [{ id: 'web' }],
    tools: [
      { type: 'openrouter:web_search' },
      { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
    ],
  };

  const userByok: BYOKResult[] = [{ providerId: 'anthropic', decryptedAPIKey: 'key' }];

  async function applyTo(model: string, byok: BYOKResult[] | null = null) {
    const request = makeRequest(model);
    Object.assign(request.body, structuredClone(fields));
    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      byok,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );
    return request.body;
  }

  it('removes them from free model requests', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const body = await applyTo('vendor/model:free');

    expect(body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    expect(body.tools).toEqual([fields.tools[1]]);
    warn.mockRestore();
  });

  it('keeps them for paid model requests without BYOK', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const body = await applyTo('vendor/model');

    expect(body).toMatchObject(fields);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes them from paid model requests with user BYOK', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const body = await applyTo('vendor/model', userByok);

    expect(body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    expect(body.tools).toEqual([fields.tools[1]]);
    warn.mockRestore();
  });

  it('removes Vercel server tools from user BYOK requests routed through Vercel', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = 'anthropic/claude-sonnet-4.5';
    const request = makeRequest(model);
    Object.assign(request.body, {
      tools: [{ type: 'vercel:perplexity_search' }, structuredClone(fields.tools[1])],
      tool_choice: { type: 'vercel:perplexity_search' },
    });

    await applyProviderSpecificLogic(
      VERCEL_AI_GATEWAY,
      model,
      request,
      {},
      userByok,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );

    expect(request.body.tools).toEqual([fields.tools[1]]);
    expect(request.body).not.toHaveProperty('tool_choice');
    expect(request.body).not.toHaveProperty('plugins');
    expect(warn).toHaveBeenCalledWith(
      '[applyProviderSpecificLogic] Removed paid server features from free or BYOK request',
      expect.objectContaining({ model, removedToolTypes: ['vercel:perplexity_search'] })
    );
    warn.mockRestore();
  });
});

describe('applyPreferredProvider', () => {
  const config: PreferredProviderOrderConfig = {
    rules: [
      { includes: ['openai', 'gpt'], excludes: ['gpt-oss'], providers: ['openai'] },
      { includes: ['claude'], providers: ['google-vertex', 'amazon-bedrock'] },
      { includes: ['kimi'], providers: ['amazon-bedrock', 'alibaba'] },
    ],
  };

  it.each(['openai/gpt-5.6-terra', 'openai/o3', 'gpt-5.5'])(
    'applies the order of the first matching rule to %s',
    model => {
      const request = makeRequest(model);

      applyPreferredProvider(config, model, request.body, false);

      expect(request.body.provider).toEqual({ order: ['openai'] });
    }
  );

  it('does not set a provider order when an exclude skips the rule', () => {
    const model = 'openai/gpt-oss-120b';
    const request = makeRequest(model);

    applyPreferredProvider(config, model, request.body, false);

    expect(request.body.provider).toBeUndefined();
  });

  it('does not set a provider order without a stored config', () => {
    const model = 'openai/gpt-5.5';
    const request = makeRequest(model);

    applyPreferredProvider(EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG, model, request.body, false);

    expect(request.body.provider).toBeUndefined();
  });

  it('still ignores Anthropic for Claude without a stored config', () => {
    const model = 'anthropic/claude-sonnet-4.5';
    const request = makeRequest(model);

    applyPreferredProvider(EMPTY_PREFERRED_PROVIDER_ORDER_CONFIG, model, request.body, false);

    expect(request.body.provider).toEqual({ ignore: ['anthropic'] });
  });

  it('prefers Vertex then Bedrock and ignores Anthropic for Fable', () => {
    const request = makeRequest('anthropic/claude-fable-5');

    applyPreferredProvider(config, 'anthropic/claude-fable-5', request.body, false);

    expect(request.body.provider).toEqual({
      order: ['google-vertex', 'amazon-bedrock'],
      ignore: ['anthropic'],
    });
  });

  it('does not ignore Anthropic for Claude when Anthropic is allowed', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');

    applyPreferredProvider(config, 'anthropic/claude-sonnet-4.5', request.body, true);

    expect(request.body.provider).toEqual({ order: ['google-vertex', 'amazon-bedrock'] });
  });

  it('ignores Anthropic for Claude even when the caller set an order', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    request.body.provider = { order: ['anthropic'], ignore: ['azure', 'anthropic'] };

    applyPreferredProvider(config, 'anthropic/claude-sonnet-4.5', request.body, false);

    expect(request.body.provider).toEqual({
      order: ['anthropic'],
      ignore: ['azure', 'anthropic'],
    });
  });

  it('does not ignore Anthropic for non-Claude models', () => {
    const request = makeRequest('openai/gpt-5.5');

    applyPreferredProvider(config, 'openai/gpt-5.5', request.body, false);

    expect(request.body.provider).toEqual({ order: ['openai'] });
  });

  it('preserves valid provider options when adding order', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    request.body.provider = { zdr: true };

    applyPreferredProvider(config, 'anthropic/claude-sonnet-4.5', request.body, false);

    expect(request.body.provider).toEqual({
      zdr: true,
      order: ['google-vertex', 'amazon-bedrock'],
      ignore: ['anthropic'],
    });
  });

  it('preserves an explicit provider order and allowed providers', () => {
    const request = makeRequest('moonshotai/kimi-k3');
    request.body.provider = { only: ['alibaba'], order: ['alibaba'] };

    applyPreferredProvider(config, 'moonshotai/kimi-k3', request.body, false);

    expect(request.body.provider).toEqual({ only: ['alibaba'], order: ['alibaba'] });
  });

  it('overwrites a malformed provider value', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    Object.assign(request.body, { provider: 'lmstudio' });

    applyPreferredProvider(config, 'anthropic/claude-sonnet-4.5', request.body, false);

    expect(request.body.provider).toEqual({
      order: ['google-vertex', 'amazon-bedrock'],
      ignore: ['anthropic'],
    });
  });
});

describe('applyProviderSpecificLogic Anthropic provider ignore', () => {
  async function applyToClaude(isNonTrialEnterprise: boolean, userByok: BYOKResult[] | null) {
    const model = 'anthropic/claude-sonnet-4.5';
    const request = makeRequest(model);

    await applyProviderSpecificLogic(
      makeProvider(null),
      model,
      request,
      {},
      userByok,
      EmptyFraudDetectionHeaders,
      'user-1',
      'org-1',
      null,
      null,
      isNonTrialEnterprise
    );

    return request.body.provider;
  }

  it('ignores Anthropic outside non-trial enterprise organizations', async () => {
    expect((await applyToClaude(false, null))?.ignore).toEqual(['anthropic']);
  });

  it('does not ignore Anthropic for non-trial enterprise organizations', async () => {
    expect((await applyToClaude(true, null))?.ignore).toBeUndefined();
  });

  it('does not ignore Anthropic for BYOK requests', async () => {
    expect(
      (await applyToClaude(false, [{ providerId: 'anthropic', decryptedAPIKey: 'key' }]))?.ignore
    ).toBeUndefined();
  });
});

describe('withIgnoredProviders', () => {
  it('returns the provider unchanged when nothing is ignored', () => {
    const provider = { order: ['openai'] };

    expect(withIgnoredProviders(provider, [])).toBe(provider);
    expect(withIgnoredProviders(undefined, [])).toBeUndefined();
  });

  it('merges ignored providers without duplicates', () => {
    expect(withIgnoredProviders({ zdr: true, ignore: ['anthropic'] }, ['anthropic'])).toEqual({
      zdr: true,
      ignore: ['anthropic'],
    });
    expect(withIgnoredProviders(undefined, ['anthropic'])).toEqual({ ignore: ['anthropic'] });
  });
});

describe('getIgnoredProviders', () => {
  it.each([
    ['anthropic/claude-opus-5', false, ['anthropic']],
    ['anthropic/claude-opus-5', true, []],
    ['openai/gpt-5.5', false, []],
  ] as const)('for %s with Anthropic allowed=%s returns %j', (model, allowed, expected) => {
    expect(getIgnoredProviders(model, allowed)).toEqual(expected);
  });
});
