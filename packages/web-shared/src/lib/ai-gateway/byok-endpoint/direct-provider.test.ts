import { describe, expect, it } from '@jest/globals';
import type { ByokEndpointCredentials, ByokEndpointDefinition } from '@kilocode/db/schema-types';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { applyTrackingIds } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  getDirectByokKeyLabel,
  getDirectByokModels,
  getDirectByokModelChatApis,
  getDirectByokPolicyTarget,
  getDirectByokUpstreamModelId,
  supportsCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  createByokEndpointDirectProvider,
  InvalidByokEndpointCredentialsError,
} from './direct-provider';

const PROVIDER_ID = 'endpoint-a1b2c3d4e5';
const API_KEY: ByokEndpointCredentials = { type: 'api_key', api_key: 'key' };

function definition(overrides: Partial<ByokEndpointDefinition> = {}): ByokEndpointDefinition {
  return {
    name: 'Acme',
    base_url: 'https://llm.acme.example/v1',
    api_kinds: ['chat_completions', 'messages'],
    client_provider: 'openrouter',
    reasoning_format: 'reasoning-content',
    models: [
      {
        id: 'acme/coder',
        internal_id: 'Acme Coder/v2',
        context_length: 1000,
        max_completion_tokens: 100,
      },
    ],
    ...overrides,
  };
}

async function firstModel(endpoint: ByokEndpointDefinition) {
  const [model] = await createByokEndpointDirectProvider(PROVIDER_ID, endpoint).models();
  if (!model) throw new Error('expected a model');
  return model;
}

async function transform(endpoint: ByokEndpointDefinition, request: GatewayRequest) {
  const provider = createByokEndpointDirectProvider(PROVIDER_ID, endpoint);
  const gatewayProvider = { type: 'direct-byok' } as Provider;
  applyTrackingIds(request, gatewayProvider, 'user-1', 'task-1');
  const extraHeaders: Record<string, string> = {};
  provider.transformRequest(
    {
      provider: gatewayProvider,
      model: `${PROVIDER_ID}/acme/coder`,
      request,
      originalHeaders: EmptyFraudDetectionHeaders,
      extraHeaders,
      userByok: null,
      kilo_user_id: 'user-1',
      organization_id: 'org-1',
      session_id: null,
    },
    await firstModel(endpoint)
  );
  return { body: request.body as Record<string, unknown>, extraHeaders };
}

function chatRequest(): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: { model: `${PROVIDER_ID}/acme/coder`, messages: [{ role: 'user', content: 'hi' }] },
  };
}

function messagesRequest(): GatewayRequest {
  return {
    kind: 'messages',
    body: {
      model: `${PROVIDER_ID}/acme/coder`,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
      metadata: { user_id: 'client' },
    },
  };
}

describe('createByokEndpointDirectProvider', () => {
  it('is an organization endpoint that serves catalog ids in catalog mode', async () => {
    const endpoint = definition();
    const provider = createByokEndpointDirectProvider(PROVIDER_ID, endpoint);

    expect(createByokEndpointDirectProvider(PROVIDER_ID, endpoint)).toBe(provider);
    expect(getDirectByokKeyLabel(provider)).toBe('Acme endpoint');
    expect(getDirectByokPolicyTarget(provider)).toEqual({ kind: 'organization-endpoint' });
    expect(supportsCatalogMode(provider)).toBe(true);
    expect(await provider.models()).toEqual([
      expect.objectContaining({
        id: 'acme/coder',
        name: 'acme/coder',
        catalog_model_id: 'acme/coder',
        reasoning_options: undefined,
      }),
    ]);
  });

  it('serves a model under its upstream id over the APIs it lists', async () => {
    const endpoint = definition();
    const provider = createByokEndpointDirectProvider(PROVIDER_ID, endpoint);
    const model = await firstModel(endpoint);

    expect(getDirectByokUpstreamModelId(provider, model)).toBe('Acme Coder/v2');
    expect(getDirectByokModelChatApis(provider, model)).toEqual(['chat_completions', 'messages']);
    expect(provider.getModelChatApi?.(model)).toBe('chat_completions');
    await expect(
      provider.resolveUpstream({ credential: JSON.stringify(API_KEY), model, stream: false })
    ).resolves.toEqual({
      apiUrl: 'https://llm.acme.example/v1',
      apiUrlOverrides: {},
      disableUrlSuffix: false,
      apiKey: 'key',
      apiKeyHeader: null,
      supportedChatApis: ['chat_completions', 'messages'],
      responseTransforms: 'reasoning-content',
    });
  });

  it('uses the model overrides of the endpoint defaults', async () => {
    const base = definition();
    const endpoint = definition({
      models: [
        {
          ...base.models[0],
          api_kinds: ['responses'],
          client_provider: 'openai',
          reasoning_format: 'reasoning-details',
        },
      ],
    });
    const provider = createByokEndpointDirectProvider(PROVIDER_ID, endpoint);
    const model = await firstModel(endpoint);

    expect(provider.getModelChatApi?.(model)).toBe('responses');
    const upstream = await provider.resolveUpstream({
      credential: JSON.stringify(API_KEY),
      model,
      stream: false,
    });
    expect(upstream).toMatchObject({ supportedChatApis: ['responses'], responseTransforms: null });
  });

  it('authenticates with an x-api-key header or AWS SigV4', async () => {
    const endpoint = definition();
    const provider = createByokEndpointDirectProvider(PROVIDER_ID, endpoint);
    const model = await firstModel(endpoint);
    const resolve = (credentials: ByokEndpointCredentials) =>
      provider.resolveUpstream({ credential: JSON.stringify(credentials), model, stream: false });

    await expect(resolve({ type: 'x-api-key', api_key: 'key' })).resolves.toMatchObject({
      apiKey: 'key',
      apiKeyHeader: 'x-api-key',
    });
    const bedrock = {
      type: 'aws_bedrock' as const,
      region: 'us-east-1',
      access_key_id: 'AKIA',
      secret_access_key: 'secret',
    };
    await expect(resolve(bedrock)).resolves.toMatchObject({ apiKey: '', awsBedrock: bedrock });
  });

  it('refuses credentials that do not parse', async () => {
    const endpoint = definition();
    const provider = createByokEndpointDirectProvider(PROVIDER_ID, endpoint);
    const model = await firstModel(endpoint);

    await expect(
      provider.resolveUpstream({ credential: 'not json', model, stream: false })
    ).rejects.toBeInstanceOf(InvalidByokEndpointCredentialsError);
  });

  it('removes the tracking ids Kilo adds', async () => {
    const { body } = await transform(definition(), chatRequest());

    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('safety_identifier');
  });

  it('sends the prompt cache key only where the endpoint or model turns it on', async () => {
    const base = definition();
    const withModel = (send_prompt_cache_key: boolean | undefined) =>
      definition({
        send_prompt_cache_key: true,
        models: [{ ...base.models[0], send_prompt_cache_key }],
      });

    expect((await transform(base, chatRequest())).body).not.toHaveProperty('prompt_cache_key');
    expect((await transform(withModel(undefined), chatRequest())).body.prompt_cache_key).toEqual(
      expect.any(String)
    );
    expect((await transform(withModel(false), chatRequest())).body).not.toHaveProperty(
      'prompt_cache_key'
    );
  });

  it('drops metadata.user_id and the metadata it leaves empty', async () => {
    const { body } = await transform(definition(), messagesRequest());
    expect(body).not.toHaveProperty('metadata');

    const request = messagesRequest();
    if (request.kind !== 'messages') throw new Error('expected a Messages request');
    // Upstreams may accept more metadata than the Anthropic type declares.
    request.body.metadata = { user_id: 'client', trace: 'kept' } as typeof request.body.metadata;
    const { body: withOtherMetadata } = await transform(definition(), request);
    expect(withOtherMetadata.metadata).toEqual({ trace: 'kept' });
  });

  it('sends anthropic-version on Messages requests only', async () => {
    const { extraHeaders } = await transform(definition(), messagesRequest());
    expect(extraHeaders['anthropic-version']).toBe('2023-06-01');
    const { extraHeaders: chatHeaders } = await transform(definition(), chatRequest());
    expect(chatHeaders).not.toHaveProperty('anthropic-version');
  });

  it('offers reasoning options for reasoning models, falling back to the upstream id', async () => {
    const base = definition();
    const model = await firstModel(
      definition({
        models: [{ ...base.models[0], internal_id: 'claude-sonnet-4-6', flags: ['reasoning'] }],
      })
    );

    expect(model.reasoning_options?.length).toBeGreaterThan(0);
  });
});

describe('endpoint model lists', () => {
  it('lists the models of endpoints outside catalog mode like direct BYOK models', async () => {
    const base = definition();
    const bespoke = definition({
      client_provider: 'anthropic',
      models: [
        { ...base.models[0], id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet', flags: ['vision'] },
      ],
    });

    const models = await getDirectByokModels([
      { providerId: PROVIDER_ID, serveCatalogModels: false, endpoint: bespoke },
      { providerId: 'endpoint-bbbbbbbbbb', serveCatalogModels: true, endpoint: definition() },
    ]);

    expect(models).toEqual([
      expect.objectContaining({
        id: `${PROVIDER_ID}/anthropic/claude-sonnet-4.6`,
        name: 'Acme: Sonnet',
        architecture: expect.objectContaining({ input_modalities: ['text', 'image'] }),
        hasUserByokAvailable: true,
        isFree: false,
        opencode: expect.objectContaining({ ai_sdk_provider: 'anthropic' }),
      }),
    ]);
  });
});
