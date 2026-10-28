import { ModelsDevProviderSchema } from './models-dev';
import { parseGcpVertexModelsDevModels } from './vertex-models';

describe('parseGcpVertexModelsDevModels', () => {
  test('routes each model family to the endpoint that serves it, Grok always through Responses', () => {
    const models = {
      'gemini-3.5-flash': { id: 'gemini-3.5-flash' },
      'zai-org/glm-5.2-maas': {
        id: 'zai-org/glm-5.2-maas',
        provider: { npm: '@ai-sdk/openai-compatible' },
      },
      'claude-sonnet-4-6@default': {
        id: 'claude-sonnet-4-6@default',
        provider: { npm: '@ai-sdk/google-vertex/anthropic' },
      },
      'xai/grok-4.20-reasoning': {
        id: 'xai/grok-4.20-reasoning',
        reasoning: true,
        provider: { npm: '@ai-sdk/openai-compatible' },
      },
      'xai/grok-4.20-non-reasoning': {
        id: 'xai/grok-4.20-non-reasoning',
        reasoning: false,
        provider: { npm: '@ai-sdk/openai-compatible' },
      },
      'mistral-medium-3': { id: 'mistral-medium-3', provider: { npm: '@ai-sdk/mistral' } },
      'gemini-embedding-001': { id: 'gemini-embedding-001', tool_call: false },
    };

    expect(
      parseGcpVertexModelsDevModels(ModelsDevProviderSchema.parse({ models })).map(({ id, endpoint }) => ({ id, endpoint }))
    ).toEqual([
      { id: 'gemini-3.5-flash', endpoint: 'openapi' },
      { id: 'zai-org/glm-5.2-maas', endpoint: 'openapi' },
      { id: 'claude-sonnet-4-6@default', endpoint: 'anthropic' },
      { id: 'xai/grok-4.20-reasoning', endpoint: 'openapi-responses' },
      { id: 'xai/grok-4.20-non-reasoning', endpoint: 'openapi-responses' },
      { id: 'mistral-medium-3', endpoint: 'mistral' },
    ]);
  });
});
