import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'chutes',
  name: 'Chutes',
  base_url: 'https://llm.chutes.ai/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: [
    {
      id: 'zai-org/GLM-4.7-FP8',
      name: 'GLM-4.7',
      description:
        "GLM-4.7 is Z.ai's flagship model, featuring upgrades in programming capabilities and more stable multi-step reasoning/execution. It demonstrates significant improvements in executing complex agent tasks.",
      flags: ['recommended'],
      context_length: 202752,
      max_completion_tokens: 65535,
      variants: null,
    },
    {
      id: 'zai-org/GLM-5.1-TEE',
      name: 'GLM-5.1',
      description:
        "GLM-5.1 is Z.ai's latest iteration of the flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows, with advanced agentic planning and deep backend reasoning.",
      flags: ['recommended'],
      context_length: 202752,
      max_completion_tokens: 65535,
      variants: null,
    },
    {
      id: 'zai-org/GLM-5-Turbo',
      name: 'GLM-5 Turbo',
      description:
        'GLM-5 Turbo is optimized for fast inference and strong performance in agent-driven environments, with improved complex instruction decomposition, tool use, and stability across extended tasks.',
      flags: [],
      context_length: 202752,
      max_completion_tokens: 65535,
      variants: null,
    },
    {
      id: 'zai-org/GLM-5-TEE',
      name: 'GLM-5',
      description:
        "GLM-5 is Z.ai's flagship open-source model engineered for complex systems design and long-horizon agent workflows, with advanced agentic planning and deep backend reasoning.",
      flags: [],
      context_length: 202752,
      max_completion_tokens: 65535,
      variants: null,
    },
    {
      id: 'moonshotai/Kimi-K2.6-TEE',
      name: 'Kimi K2.6',
      description:
        'Kimi K2.6 is a large-scale Mixture-of-Experts multimodal model with strong performance on coding, math, and reasoning tasks, supporting a 256K context window.',
      flags: ['recommended', 'vision'],
      context_length: 262144,
      max_completion_tokens: 65535,
      variants: null,
    },
    {
      id: 'moonshotai/Kimi-K2.5-TEE',
      name: 'Kimi K2.5',
      description:
        'Kimi K2.5 is a large-scale Mixture-of-Experts multimodal model with strong coding and reasoning capabilities and a 256K context window.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 65535,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3.5-397B-A17B-TEE',
      name: 'Qwen3.5 397B',
      description:
        'Qwen3.5 397B is the largest model in the Qwen3.5 MoE family, offering flagship-level performance on coding, reasoning, and instruction-following with a 262K context window.',
      flags: ['recommended', 'vision'],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3-Coder-Next-TEE',
      name: 'Qwen3 Coder Next',
      description:
        'Qwen3 Coder Next is the latest member of the Qwen3 coding series, purpose-built for agentic code generation and large-codebase understanding with a 262K context.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
      name: 'Qwen3 Next 80B A3B',
      description:
        'Qwen3 Next 80B A3B Instruct is an efficient MoE instruction-tuned model offering strong performance with a 262K context window and matching output length.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
      name: 'Qwen3 235B A22B Instruct',
      description:
        'Qwen3 235B A22B Instruct is a large MoE instruction-tuned Qwen3 model providing strong multi-task performance with a 262K context window.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      name: 'Qwen3 235B A22B Thinking',
      description:
        'Qwen3 235B A22B Thinking is a reasoning-optimized variant of the Qwen3 235B MoE model with extended chain-of-thought capabilities and a 262K context window.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'Qwen/Qwen3.6-27B-TEE',
      name: 'Qwen3.6 27B',
      description:
        'Qwen3.6 27B is a mid-size multimodal model from the Qwen3.6 family, balancing strong coding and instruction-following performance with vision input support.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'deepseek-ai/DeepSeek-V3.2-TEE',
      name: 'DeepSeek V3.2',
      description:
        'DeepSeek V3.2 is the latest iteration of the DeepSeek V3 series, delivering strong code generation and reasoning with a 128K context window.',
      flags: ['recommended'],
      context_length: 131072,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'deepseek-ai/DeepSeek-V3.1-TEE',
      name: 'DeepSeek V3.1',
      description:
        'DeepSeek V3.1 is a strong general-purpose MoE model with broad coding and reasoning capabilities and a 160K context window.',
      flags: [],
      context_length: 163840,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'deepseek-ai/DeepSeek-R1-0528-TEE',
      name: 'DeepSeek R1',
      description:
        'DeepSeek R1 is a reasoning-focused model that delivers strong performance on math, code, and complex chain-of-thought tasks with a 160K context window.',
      flags: [],
      context_length: 163840,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'MiniMaxAI/MiniMax-M2.5-TEE',
      name: 'MiniMax M2.5',
      description:
        'MiniMax M2.5 is a large-scale mixture-of-experts model optimized for long-context understanding and generation with up to 192K context.',
      flags: [],
      context_length: 196608,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'openai/gpt-oss-120b-TEE',
      name: 'GPT-OSS-120B',
      description:
        "OpenAI's open-weight 120B model, designed for production, general-purpose, high-reasoning use cases with a 128K context window.",
      flags: [],
      context_length: 131072,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'google/gemma-4-31B-turbo-TEE',
      name: 'Gemma 4 31B Turbo',
      description:
        "Google's Gemma 4 31B Turbo is a fast multimodal model suitable for general-purpose inference with vision input and a 128K context window.",
      flags: ['vision'],
      context_length: 131072,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'XiaomiMiMo/MiMo-V2-Flash-TEE',
      name: 'MiMo V2 Flash',
      description:
        "Xiaomi's MiMo V2 Flash is a fast inference model with a 262K context window, targeting efficient general-purpose and coding workloads.",
      flags: [],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
  ],
} satisfies DirectByokProvider;
