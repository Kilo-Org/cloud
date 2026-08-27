export const gatewayModelIdCases: { cloudModel: string; gatewayModelId: string }[] = [
  { cloudModel: 'fake-deterministic', gatewayModelId: 'fake-deterministic' },
  { cloudModel: 'kilo/fake-deterministic', gatewayModelId: 'fake-deterministic' },
  { cloudModel: '  fake-deterministic\t', gatewayModelId: 'fake-deterministic' },
  { cloudModel: '\t kilo/fake-deterministic \n', gatewayModelId: 'fake-deterministic' },
  { cloudModel: 'anthropic/claude-sonnet-4', gatewayModelId: 'anthropic/claude-sonnet-4' },
  { cloudModel: 'kilo/anthropic/claude-sonnet-4', gatewayModelId: 'anthropic/claude-sonnet-4' },
  { cloudModel: 'openai/gpt-4.1', gatewayModelId: 'openai/gpt-4.1' },
  { cloudModel: 'kilo/openai/gpt-4.1', gatewayModelId: 'openai/gpt-4.1' },
  { cloudModel: 'google/gemini-2.5-pro', gatewayModelId: 'google/gemini-2.5-pro' },
  { cloudModel: 'kilo/google/gemini-2.5-pro', gatewayModelId: 'google/gemini-2.5-pro' },
  { cloudModel: 'kilo-auto/efficient', gatewayModelId: 'kilo-auto/efficient' },
  { cloudModel: 'kilo/kilo-auto/efficient', gatewayModelId: 'kilo-auto/efficient' },
  { cloudModel: 'kilo-auto/free', gatewayModelId: 'kilo-auto/free' },
  { cloudModel: 'kilo/kilo-auto/free', gatewayModelId: 'kilo-auto/free' },
  { cloudModel: 'openrouter/free', gatewayModelId: 'openrouter/free' },
  { cloudModel: 'kilo/openrouter/free', gatewayModelId: 'openrouter/free' },
  { cloudModel: 'vendor/team/model:free~alias', gatewayModelId: 'vendor/team/model:free~alias' },
  {
    cloudModel: 'kilo/vendor/team/model:free~alias',
    gatewayModelId: 'vendor/team/model:free~alias',
  },
  {
    cloudModel: 'kilo/vendor/Team/Model:free~Alias',
    gatewayModelId: 'vendor/Team/Model:free~Alias',
  },
  { cloudModel: 'kilo/kilo/example', gatewayModelId: 'kilo/example' },
  {
    cloudModel: 'nvidia-byok/nvidia/nemotron-3-super-120b-a12b',
    gatewayModelId: 'nvidia-byok/nvidia/nemotron-3-super-120b-a12b',
  },
  {
    cloudModel: 'kilo/nvidia-byok/nvidia/nemotron-3-super-120b-a12b',
    gatewayModelId: 'nvidia-byok/nvidia/nemotron-3-super-120b-a12b',
  },
  {
    cloudModel: 'kilo/chutes-byok/moonshotai/kimi-k2.6-tee',
    gatewayModelId: 'chutes-byok/moonshotai/kimi-k2.6-tee',
  },
  { cloudModel: 'kimi-coding/kimi-for-coding', gatewayModelId: 'kimi-coding/kimi-for-coding' },
  { cloudModel: 'kilo/kimi-coding/kimi-for-coding', gatewayModelId: 'kimi-coding/kimi-for-coding' },
  { cloudModel: 'kilo-internal/test-model-1', gatewayModelId: 'kilo-internal/test-model-1' },
  { cloudModel: 'kilo/kilo-internal/test-model-1', gatewayModelId: 'kilo-internal/test-model-1' },
  {
    cloudModel: '~anthropic/claude-sonnet-latest',
    gatewayModelId: '~anthropic/claude-sonnet-latest',
  },
  {
    cloudModel: 'kilo/~anthropic/claude-sonnet-latest',
    gatewayModelId: '~anthropic/claude-sonnet-latest',
  },
];

export const invalidCloudModelIds = ['', ' \t\n ', 'kilo/', '  kilo/ \t\n'];
