import { REASONING_VARIANTS_BINARY } from '@/lib/ai-gateway/providers/model-settings';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'nano-gpt',
  name: 'NanoGPT',
  base_url: 'https://nano-gpt.com/api/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: [
    {
      id: 'anthropic/claude-opus-4.6',
      name: 'Claude Opus 4.6',
      description:
        "Anthropic's flagship Claude Opus 4.6 model, offering top-tier reasoning and coding performance with an extended 1M context window.",
      flags: ['recommended', 'vision'],
      context_length: 1000000,
      max_completion_tokens: 128000,
      variants: REASONING_VARIANTS_BINARY,
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      description:
        "Anthropic's Claude Sonnet 4.6 delivers strong general-purpose and coding performance with a 1M context window at a balanced price point.",
      flags: ['recommended', 'vision'],
      context_length: 1000000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'claude-sonnet-4-5-20250929-thinking',
      name: 'Claude Sonnet 4.5 Thinking',
      description:
        'Claude Sonnet 4.5 with extended thinking enabled, combining a 1M context window with deeper reasoning for complex coding and agent workflows.',
      flags: ['vision'],
      context_length: 1000000,
      max_completion_tokens: 64000,
      variants: null,
    },
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      description:
        "Anthropic's Claude Haiku 4.5 is a fast, low-cost model optimized for high-throughput coding and general-purpose tasks with a 200K context.",
      flags: ['vision'],
      context_length: 200000,
      max_completion_tokens: 64000,
      variants: null,
    },
    {
      id: 'openai/gpt-5.2',
      name: 'GPT-5.2',
      description:
        "OpenAI's GPT-5.2 is a flagship reasoning model with a 400K context window, strong coding performance, and native multimodal input.",
      flags: ['recommended', 'vision'],
      context_length: 400000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'openai/gpt-5.2-codex',
      name: 'GPT-5.2 Codex',
      description:
        'GPT-5.2 Codex is a code-specialized variant of GPT-5.2, tuned for agentic software engineering tasks with a 400K context window.',
      flags: ['recommended', 'vision'],
      context_length: 400000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'openai/gpt-5.1-codex-max',
      name: 'GPT-5.1 Codex Max',
      description:
        'GPT-5.1 Codex Max is a coding-focused variant of GPT-5.1 optimized for large-scale software engineering tasks with a 400K context window.',
      flags: ['vision'],
      context_length: 400000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'openai/gpt-5.1',
      name: 'GPT-5.1',
      description:
        "OpenAI's GPT-5.1 reasoning model with a 400K context window and strong general-purpose and coding capabilities.",
      flags: ['vision'],
      context_length: 400000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      description:
        'GPT-5 is a flagship OpenAI reasoning model with a 400K context window and native multimodal support.',
      flags: ['vision'],
      context_length: 400000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'google/gemini-3-flash-preview',
      name: 'Gemini 3 Flash (Preview)',
      description:
        "Google's Gemini 3 Flash (Preview) is a fast, low-latency model with an extended 1M+ context window and native multimodal input.",
      flags: ['vision'],
      context_length: 1048576,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'gemini-3-pro-preview-thinking',
      name: 'Gemini 3 Pro (Thinking)',
      description:
        "Google's Gemini 3 Pro with extended thinking, combining flagship reasoning with a 1M+ context window and native multimodal input.",
      flags: ['vision'],
      context_length: 1048576,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'x-ai/grok-4.1-fast',
      name: 'Grok 4.1 Fast',
      description:
        "Grok 4.1 Fast is xAI's latest low-latency reasoning model, offering an exceptional 2M context window and native multimodal input.",
      flags: ['vision'],
      context_length: 2000000,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'zai-org/glm-5.1',
      name: 'GLM 5.1',
      description:
        "Z.ai's GLM 5.1 is a flagship open-source model engineered for complex systems design and long-horizon agent workflows, with advanced agentic planning and deep backend reasoning.",
      flags: [],
      context_length: 200000,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'zai-org/glm-4.7',
      name: 'GLM 4.7',
      description:
        "Z.ai's GLM 4.7 features enhanced programming capabilities and more stable multi-step reasoning/execution for complex agent tasks.",
      flags: [],
      context_length: 200000,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'moonshotai/kimi-k2.6',
      name: 'Kimi K2.6',
      description:
        "Moonshot AI's Kimi K2.6 is a large MoE model with strong coding performance, native multimodal input, and a 256K context window.",
      flags: ['vision'],
      context_length: 256000,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'moonshotai/kimi-k2-thinking',
      name: 'Kimi K2 Thinking',
      description:
        "Kimi K2 Thinking is a reasoning-optimized variant of Moonshot AI's Kimi K2, supporting extended chain-of-thought with a 256K context window.",
      flags: [],
      context_length: 256000,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'deepseek/deepseek-v3.2',
      name: 'DeepSeek V3.2',
      description:
        'DeepSeek V3.2 delivers strong code generation and reasoning with a 163K context window and native multimodal support.',
      flags: ['vision'],
      context_length: 163000,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'minimax/minimax-m2.7',
      name: 'MiniMax M2.7',
      description:
        "MiniMax's M2.7 is a reasoning-oriented large model with a 200K context window, optimized for long-context understanding and generation.",
      flags: [],
      context_length: 204800,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'openai/gpt-oss-120b',
      name: 'GPT-OSS-120B',
      description:
        "OpenAI's open-weight 120B model, designed for production, general-purpose, and high-reasoning use cases.",
      flags: [],
      context_length: 128000,
      max_completion_tokens: 16384,
      variants: null,
    },
    {
      id: 'meta-llama/llama-4-maverick',
      name: 'Llama 4 Maverick',
      description:
        "Meta's Llama 4 Maverick is a large MoE model with a 1M context window and native multimodal input, suitable for general-purpose inference.",
      flags: ['vision'],
      context_length: 1048576,
      max_completion_tokens: 65536,
      variants: null,
    },
  ],
} satisfies DirectByokProvider;
