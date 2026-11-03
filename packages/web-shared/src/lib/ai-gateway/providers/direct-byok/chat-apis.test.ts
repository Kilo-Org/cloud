import { describe, expect, test } from '@jest/globals';
import { getDirectByokModelChatApis } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import DIRECT_BYOK_PROVIDERS from './direct-byok-definitions';
import type { DirectByokProvider } from './types';
import bedrockByok, { AwsBedrockEndpointSchema, resolveAwsBedrockUpstream } from './bedrock-byok';
import vertexByok, { buildGcpVertexUpstream, GcpVertexEndpointSchema } from './vertex-byok';

// Routing and the BYOK routing preview choose keys by `getDirectByokModelChatApis`, without the
// credential, while requests use the upstream resolved from it. The two must agree.
const providers: ReadonlyArray<DirectByokProvider> = DIRECT_BYOK_PROVIDERS;

describe('getDirectByokModelChatApis', () => {
  test.each(
    providers
      .filter(provider => provider.supportedChatApis !== undefined)
      .map(provider => [provider.id, provider] as const)
  )('matches the upstream %s resolves', async (_id, provider) => {
    const model = {
      id: 'upstream-model',
      name: 'Model',
      context_length: 1,
      max_completion_tokens: 1,
    };
    const upstream = await provider.resolveUpstream({
      credential: 'test-key',
      model,
      stream: false,
    });
    expect(upstream.supportedChatApis).toEqual(getDirectByokModelChatApis(provider, model));
  });

  test.each(AwsBedrockEndpointSchema.options)('matches the Bedrock %s upstream', endpoint => {
    const model = {
      id: 'vendor.model-v1',
      name: 'Model',
      context_length: 1,
      max_completion_tokens: 1,
      endpoint,
    };
    const upstream = resolveAwsBedrockUpstream(
      JSON.stringify({ apiKey: 'test-key', region: 'us-east-1' }),
      model
    );
    expect(upstream.supportedChatApis).toEqual(getDirectByokModelChatApis(bedrockByok, model));
  });

  test.each(GcpVertexEndpointSchema.options)('matches the Vertex AI %s upstream', endpoint => {
    const model = {
      id: 'vendor-model-v1',
      name: 'Model',
      context_length: 1,
      max_completion_tokens: 1,
      endpoint,
    };
    const upstream = buildGcpVertexUpstream(
      {
        project: 'my-project',
        location: 'us-central1',
        clientEmail: 'sa@my-project.iam.gserviceaccount.com',
        privateKey: 'private-key',
      },
      'access-token',
      model,
      false
    );
    expect(upstream.supportedChatApis).toEqual(getDirectByokModelChatApis(vertexByok, model));
  });
});
