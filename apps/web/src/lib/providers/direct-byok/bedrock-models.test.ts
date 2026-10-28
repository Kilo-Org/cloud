import { ModelsDevProviderSchema } from './models-dev';
import { parseAwsBedrockModelsDevModels } from './bedrock-models';

describe('parseAwsBedrockModelsDevModels', () => {
  const mantle = (path: string) => ({
    npm: '@ai-sdk/amazon-bedrock/mantle',
    api: `https://bedrock-mantle.\${AWS_REGION}.api.aws${path}`,
  });
  const models = {
    'anthropic.claude-sonnet-4-6': { id: 'anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    'global.anthropic.claude-sonnet-4-6': {
      id: 'global.anthropic.claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6 (Global)',
    },
    'us.anthropic.claude-sonnet-4-6': { id: 'us.anthropic.claude-sonnet-4-6' },
    'zai.glm-5': { id: 'zai.glm-5', name: 'GLM-5' },
    'openai.gpt-5.5': { id: 'openai.gpt-5.5', provider: mantle('/openai/v1') },
    'openai.gpt-6-sol': { id: 'openai.gpt-6-sol', provider: mantle('/openai/v1') },
    'global.openai.gpt-6-sol': { id: 'global.openai.gpt-6-sol' },
    'openai.gpt-oss-120b': { id: 'openai.gpt-oss-120b', provider: mantle('/v1') },
    'openai.gpt-oss-120b-1:0': { id: 'openai.gpt-oss-120b-1:0' },
    'qwen.qwen3-32b-v1:0': { id: 'qwen.qwen3-32b-v1:0' },
    'qwen.qwen3-next-80b-a3b': { id: 'qwen.qwen3-next-80b-a3b' },
    'google.gemma-4-31b': { id: 'google.gemma-4-31b', provider: mantle('/openai/v1') },
    'xai.grok-4.3': { id: 'xai.grok-4.3', provider: mantle('/openai/v1') },
    'xai.grok-4.6': { id: 'xai.grok-4.6', provider: mantle('/openai/v1') },
    'global.xai.grok-4.6': { id: 'global.xai.grok-4.6', name: 'Grok 4.6 (Global)' },
    'global.xai.grok-4.7': { id: 'global.xai.grok-4.7', name: 'Grok 4.7 (Global)' },
    'us.xai.grok-4.7': { id: 'us.xai.grok-4.7' },
    'global.moonshotai.kimi-k3': { id: 'global.moonshotai.kimi-k3', name: 'Kimi K3 (Global)' },
    'qwen.qwen3-235b-a22b-2507-v1:0': { id: 'qwen.qwen3-235b-a22b-2507-v1:0' },
    'amazon.nova-pro-v1:0': { id: 'amazon.nova-pro-v1:0' },
    'meta.llama3-1-70b-instruct-v1:0': {
      id: 'meta.llama3-1-70b-instruct-v1:0',
      status: 'deprecated',
    },
  };

  test('selects one endpoint per model and skips unsupported and deprecated models', () => {
    expect(
      parseAwsBedrockModelsDevModels(ModelsDevProviderSchema.parse({ models })).map(
        ({ id, endpoint }) => ({ id, endpoint })
      )
    ).toEqual([
      { id: 'global.anthropic.claude-sonnet-4-6', endpoint: 'runtime-anthropic' },
      { id: 'zai.glm-5', endpoint: 'mantle-chat' },
      { id: 'openai.gpt-5.5', endpoint: 'mantle-openai' },
      { id: 'openai.gpt-6-sol', endpoint: 'mantle-openai' },
      { id: 'openai.gpt-oss-120b', endpoint: 'mantle-chat' },
      { id: 'qwen.qwen3-32b', endpoint: 'mantle-chat' },
      { id: 'qwen.qwen3-next-80b-a3b', endpoint: 'runtime-openai' },
      { id: 'google.gemma-4-31b', endpoint: 'mantle-openai' },
      { id: 'xai.grok-4.3', endpoint: 'mantle-openai' },
      { id: 'global.xai.grok-4.6', endpoint: 'runtime-responses' },
      { id: 'global.xai.grok-4.7', endpoint: 'runtime-responses' },
      { id: 'global.moonshotai.kimi-k3', endpoint: 'runtime-openai' },
    ]);
  });
});
