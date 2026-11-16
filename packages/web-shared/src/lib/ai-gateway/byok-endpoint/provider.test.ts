import { describe, expect, it } from '@jest/globals';
import type { ByokEndpointDefinition } from '@kilocode/db/schema-types';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { DirectUpstreamAuth } from '@kilocode/web-shared/lib/ai-gateway/providers/build-direct-provider';
import { applyTrackingIds } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { buildByokEndpointProvider } from './provider';

const PROVIDER_ID = 'endpoint-a1b2c3d4e5';
const API_KEY_AUTH: DirectUpstreamAuth = { type: 'api_key', apiKey: 'key', apiKeyHeader: null };

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

async function transform(endpoint: ByokEndpointDefinition, request: GatewayRequest) {
  const provider = buildByokEndpointProvider(
    PROVIDER_ID,
    endpoint,
    endpoint.models[0],
    API_KEY_AUTH
  );
  applyTrackingIds(request, provider, 'user-1', 'task-1');
  await provider.transformRequest({
    provider,
    model: `${PROVIDER_ID}/acme/coder`,
    request,
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders: {},
    userByok: null,
    kilo_user_id: 'user-1',
    organization_id: 'org-1',
    session_id: null,
  });
  return { provider, body: request.body as Record<string, unknown> };
}

function chatRequest(): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: `${PROVIDER_ID}/acme/coder`,
      messages: [{ role: 'user', content: 'hi' }],
      provider: { order: ['openai'] },
    },
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

describe('buildByokEndpointProvider', () => {
  it('serves the model from the endpoint under its upstream id', async () => {
    const { provider, body } = await transform(definition(), chatRequest());

    expect(provider).toMatchObject({
      type: 'byok-endpoint',
      inferenceProviderId: PROVIDER_ID,
      byokEndpointName: 'Acme',
      apiUrl: 'https://llm.acme.example/v1',
      disableUrlSuffix: false,
      supportedChatApis: ['chat_completions', 'messages'],
      responseTransforms: 'reasoning-content',
    });
    expect(body.model).toBe('Acme Coder/v2');
  });

  it('puts the upstream id in a {model} URL instead of the body', async () => {
    const { provider, body } = await transform(
      definition({ base_url: 'https://llm.acme.example/deployments/{model}/v1' }),
      chatRequest()
    );

    expect(provider.apiUrl).toBe('https://llm.acme.example/deployments/Acme%20Coder%2Fv2/v1');
    expect(body).not.toHaveProperty('model');
  });

  it('removes OpenRouter provider routing and the tracking ids Kilo adds by default', async () => {
    const { body } = await transform(definition(), chatRequest());

    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('safety_identifier');
    expect(body.prompt_cache_key).toEqual(expect.any(String));
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

  it('forwards provider routing and tracking ids when the endpoint asks for them', async () => {
    const endpoint = definition({ forward_provider_routing: true, forward_tracking_ids: true });

    const { body } = await transform(endpoint, chatRequest());
    expect(body.provider).toEqual({ order: ['openai'] });
    expect(body.user).toEqual(expect.any(String));
    expect(body.safety_identifier).toEqual(expect.any(String));

    const { body: messagesBody } = await transform(endpoint, messagesRequest());
    expect(messagesBody.metadata).toEqual({ user_id: expect.any(String) });
  });

  it('uses the model overrides of the endpoint defaults', () => {
    const endpoint = definition();
    const provider = buildByokEndpointProvider(
      PROVIDER_ID,
      endpoint,
      {
        ...endpoint.models[0],
        api_kinds: ['responses'],
        client_provider: 'openai',
        reasoning_format: 'reasoning-details',
      },
      API_KEY_AUTH
    );

    expect(provider.supportedChatApis).toEqual(['responses']);
    expect(provider.responseTransforms).toBeNull();
  });

  it('authenticates with an x-api-key header or AWS SigV4', () => {
    const endpoint = definition();
    const xApiKey = buildByokEndpointProvider(PROVIDER_ID, endpoint, endpoint.models[0], {
      type: 'api_key',
      apiKey: 'key',
      apiKeyHeader: 'x-api-key',
    });
    expect(xApiKey).toMatchObject({ apiKey: 'key', apiKeyHeader: 'x-api-key' });

    const credentials = {
      type: 'aws_bedrock' as const,
      region: 'us-east-1',
      access_key_id: 'AKIA',
      secret_access_key: 'secret',
    };
    const bedrock = buildByokEndpointProvider(PROVIDER_ID, endpoint, endpoint.models[0], {
      type: 'aws_bedrock',
      credentials,
    });
    expect(bedrock).toMatchObject({ apiKey: '', awsBedrock: credentials });
  });
});
