import type { DirectByokProvider } from '@/lib/providers/direct-byok/types';

export default {
  id: 'neuralwatt',
  name: 'Neuralwatt',
  base_url: 'https://api.neuralwatt.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: [
    {
      id: 'moonshotai/Kimi-K2.5',
      name: 'Kimi-K2.5',
      description:
        'Kimi-K2.5 is a large-scale Mixture-of-Experts language model with strong performance on coding, math, and reasoning tasks, supporting a 256K context window.',
      flags: ['recommended', 'vision'],
      context_length: 262144,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3.5-397B-A17B-FP8',
      name: 'Qwen3.5 397B',
      description:
        'Qwen3.5 397B is the largest model in the Qwen3.5 MoE family, offering flagship-level performance on coding, reasoning, and instruction-following with a 262K context window.',
      flags: ['recommended'],
      context_length: 262144,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'zai-org/GLM-5-FP8',
      name: 'GLM-5',
      description:
        "GLM-5 is Z.ai's flagship open-source model engineered for complex systems design and long-horizon agent workflows, with advanced agentic planning and deep backend reasoning.",
      flags: ['recommended'],
      context_length: 202752,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'MiniMaxAI/MiniMax-M2.5',
      name: 'MiniMax-M2.5',
      description:
        'MiniMax-M2.5 is a large-scale mixture-of-experts model optimized for long-context understanding and generation, supporting up to 192K context.',
      flags: ['recommended'],
      context_length: 196608,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3.5-35B-A3B',
      name: 'Qwen3.5 35B',
      description:
        'Qwen3.5 35B is a compact MoE model from the Qwen3.5 family, balancing strong performance with lower latency for coding and instruction-following tasks.',
      flags: [],
      context_length: 32768,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'mistralai/Devstral-Small-2-24B-Instruct-2512',
      name: 'Devstral Small 2',
      description:
        'Devstral Small 2 is a 24B-parameter code-focused model from Mistral AI, optimized for agentic software engineering tasks with a 256K context window.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'openai/gpt-oss-20b',
      name: 'GPT-OSS-20B',
      description:
        "OpenAI's open-weight 20B model, designed for efficient general-purpose inference.",
      flags: [],
      context_length: 16384,
      max_completion_tokens: 16384,
      variants: null,
    },
  ],
} satisfies DirectByokProvider;
