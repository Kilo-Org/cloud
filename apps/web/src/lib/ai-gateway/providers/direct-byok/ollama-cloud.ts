import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

// Ollama Cloud exposes an OpenAI-compatible API at https://ollama.com/v1.
// See https://docs.ollama.com/api/openai-compatibility and https://docs.ollama.com/cloud
// Model metadata (id, context, output limits, modalities) is sourced from
// https://models.dev/api.json ("ollama-cloud" entry).
export default {
  id: 'ollama-cloud',
  name: 'Ollama Cloud',
  base_url: 'https://ollama.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: [
    {
      id: 'kimi-k2.6:cloud',
      name: 'Kimi K2.6',
      description:
        "Kimi K2.6 is Moonshot AI's next-generation multimodal model, designed for long-horizon coding, coding-driven UI/UX generation, and multi-agent orchestration.",
      flags: ['recommended', 'vision'],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      description:
        'GLM-5.1 delivers a major leap in coding capability, with particularly significant gains in handling long-horizon tasks. Unlike previous models built around minute-level interactions, GLM-5.1 can work independently and continuously on complex tasks.',
      flags: ['recommended'],
      context_length: 202752,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'minimax-m2.5',
      name: 'MiniMax-M2.5',
      description:
        'MiniMax-M2.5 is a SOTA large language model designed for real-world productivity. Trained in a diverse range of complex real-world digital working environments, M2.5 builds upon the coding expertise of M2.1.',
      flags: ['recommended'],
      context_length: 204800,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'qwen3-coder:480b',
      name: 'Qwen3-Coder 480B',
      description:
        'Qwen3-Coder-480B-A35B-Instruct is a Mixture-of-Experts (MoE) code generation model developed by the Qwen team. It is optimized for agentic coding tasks such as function calling, tool use, and long-context reasoning.',
      flags: ['recommended'],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'gpt-oss:120b',
      name: 'GPT-OSS 120B',
      description:
        "gpt-oss-120b is OpenAI's open-weight, 117B-parameter Mixture-of-Experts (MoE) language model designed for high-reasoning, agentic, and general-purpose production use cases. It activates 5.1B parameters per forward pass.",
      flags: ['recommended'],
      context_length: 131072,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'deepseek-v3.2',
      name: 'DeepSeek-V3.2',
      description:
        'DeepSeek-V3.2 is a large language model designed to harmonize high computational efficiency with strong reasoning and agentic tool-use performance. It introduces DeepSeek Sparse Attention (DSA) for efficient long-context processing.',
      flags: ['recommended'],
      context_length: 163840,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'minimax-m2.7',
      name: 'MiniMax-M2.7',
      description:
        'MiniMax-M2.7 is a next-generation large language model designed for autonomous, real-world productivity and continuous improvement, integrating advanced agentic capabilities through multi-agent orchestration.',
      flags: [],
      context_length: 204800,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'minimax-m2.1',
      name: 'MiniMax-M2.1',
      description:
        'MiniMax-M2.1 is a lightweight, state-of-the-art large language model optimized for coding, agentic workflows, and modern application development, with only 10 billion activated parameters.',
      flags: [],
      context_length: 204800,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'minimax-m2',
      name: 'MiniMax-M2',
      description:
        'MiniMax-M2 is a compact, high-efficiency large language model optimized for end-to-end coding and agentic workflows. With 10 billion activated parameters (230 billion total), it delivers near-frontier intelligence.',
      flags: [],
      context_length: 204800,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'glm-5',
      name: 'GLM-5',
      description:
        "GLM-5 is Z.ai's flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows, delivering production-grade performance on large-scale programming tasks.",
      flags: [],
      context_length: 202752,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'glm-4.7',
      name: 'GLM-4.7',
      description:
        "GLM-4.7 is Z.ai's latest flagship model, featuring upgrades in two key areas: enhanced programming capabilities and more stable multi-step reasoning/execution.",
      flags: [],
      context_length: 202752,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'glm-4.6',
      name: 'GLM-4.6',
      description:
        'GLM-4.6 expands the context window from 128K to 200K tokens, delivers superior coding performance, advanced reasoning with tool use during inference, and stronger tool-use and search-based agent capabilities over GLM-4.5.',
      flags: [],
      context_length: 202752,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      description:
        "Kimi K2.5 is Moonshot AI's native multimodal model, delivering state-of-the-art visual coding capability and a self-directed agent swarm paradigm.",
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'kimi-k2-thinking',
      name: 'Kimi K2 Thinking',
      description:
        "Kimi K2 Thinking is Moonshot AI's most advanced open reasoning model, extending the K2 series into agentic, long-horizon reasoning on a trillion-parameter Mixture-of-Experts architecture.",
      flags: [],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'kimi-k2:1t',
      name: 'Kimi K2 (1T)',
      description:
        'Kimi K2 is a large-scale Mixture-of-Experts language model developed by Moonshot AI, featuring 1 trillion total parameters with 32 billion active per forward pass, optimized for coding and agent workflows.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'qwen3.5:397b',
      name: 'Qwen3.5 397B',
      description:
        'Qwen3.5 397B-A17B is a native vision-language MoE model built on a hybrid architecture that integrates linear attention with a sparse mixture-of-experts design for flagship-level performance.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 81920,
      variants: null,
    },
    {
      id: 'qwen3-vl:235b',
      name: 'Qwen3-VL 235B Thinking',
      description:
        'Qwen3-VL-235B-A22B Thinking is a multimodal model that unifies strong text generation with visual understanding across images and video, optimized for multimodal reasoning in STEM and math.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'qwen3-vl:235b-instruct',
      name: 'Qwen3-VL 235B Instruct',
      description:
        'Qwen3-VL-235B-A22B Instruct is an open-weight multimodal model that unifies strong text generation with visual understanding across images and video, targeting general vision-language use.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'qwen3-next:80b',
      name: 'Qwen3-Next 80B',
      description:
        'Qwen3-Next-80B-A3B-Instruct is an instruction-tuned chat model optimized for fast, stable responses across reasoning, code generation, knowledge QA, and multilingual tasks.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'qwen3-coder-next',
      name: 'Qwen3-Coder Next',
      description:
        'Qwen3-Coder-Next is an open-weight causal language model optimized for coding agents and local development workflows, with 80B total parameters and only 3B activated per forward pass.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'gpt-oss:20b',
      name: 'GPT-OSS 20B',
      description:
        "gpt-oss-20b is OpenAI's open-weight 21B parameter model released under the Apache 2.0 license, using a Mixture-of-Experts architecture with 3.6B active parameters per forward pass.",
      flags: [],
      context_length: 131072,
      max_completion_tokens: 32768,
      variants: null,
    },
    {
      id: 'deepseek-v3.1:671b',
      name: 'DeepSeek-V3.1 671B',
      description:
        "DeepSeek-V3.1 is DeepSeek's large Mixture-of-Experts foundation model with strong language consistency, reasoning, and agent capabilities.",
      flags: [],
      context_length: 163840,
      max_completion_tokens: 163840,
      variants: null,
    },
    {
      id: 'cogito-2.1:671b',
      name: 'Cogito v2.1 671B',
      description:
        'Cogito v2.1 671B MoE is one of the strongest open models globally, matching performance of frontier closed and open models, trained with self-play reinforcement learning.',
      flags: [],
      context_length: 163840,
      max_completion_tokens: 32000,
      variants: null,
    },
    {
      id: 'nemotron-3-super',
      name: 'Nemotron 3 Super',
      description:
        'NVIDIA Nemotron 3 Super is a 120B-parameter open hybrid MoE model, activating just 12B parameters for maximum compute efficiency and accuracy in complex multi-agent applications.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'nemotron-3-nano:30b',
      name: 'Nemotron 3 Nano 30B',
      description:
        'NVIDIA Nemotron 3 Nano 30B A3B is a small language MoE model with high compute efficiency and accuracy for developers building specialized agentic AI systems.',
      flags: [],
      context_length: 1048576,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'mistral-large-3:675b',
      name: 'Mistral Large 3',
      description:
        "Mistral Large 3 is Mistral's most capable model to date, featuring a sparse mixture-of-experts architecture with 41B active parameters (675B total), released under the Apache 2.0 license.",
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'devstral-2:123b',
      name: 'Devstral 2 123B',
      description:
        'Devstral 2 is a state-of-the-art open-source model by Mistral AI specializing in agentic coding. It is a 123B-parameter dense transformer model supporting a 256K context window.',
      flags: [],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'devstral-small-2:24b',
      name: 'Devstral Small 2 24B',
      description:
        'Devstral Small 2 is a 24B-parameter open-weight language model for software engineering agents, developed by Mistral AI in collaboration with All Hands AI, with vision support.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'ministral-3:14b',
      name: 'Ministral 3 14B',
      description:
        'The largest model in the Ministral 3 family, Ministral 3 14B offers frontier capabilities and performance comparable to its larger Mistral Small 3.2 24B counterpart.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'ministral-3:8b',
      name: 'Ministral 3 8B',
      description:
        'A balanced model in the Ministral 3 family, Ministral 3 8B is a powerful, efficient tiny language model with vision capabilities.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'ministral-3:3b',
      name: 'Ministral 3 3B',
      description:
        'The smallest model in the Ministral 3 family, Ministral 3 3B is a powerful, efficient tiny language model with vision capabilities.',
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 128000,
      variants: null,
    },
    {
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash Preview',
      description:
        'Gemini 3 Flash Preview is a high speed, high value thinking model designed for agentic workflows, multi-turn chat, and coding assistance, delivering near Pro level reasoning and tool use.',
      flags: ['vision'],
      context_length: 1048576,
      max_completion_tokens: 65536,
      variants: null,
    },
    {
      id: 'gemma4:31b',
      name: 'Gemma 4 31B',
      description:
        "Gemma 4 31B Instruct is Google DeepMind's 30.7B dense multimodal model supporting text and image input with text output, featuring a 256K token context window.",
      flags: ['vision'],
      context_length: 262144,
      max_completion_tokens: 262144,
      variants: null,
    },
    {
      id: 'gemma3:27b',
      name: 'Gemma 3 27B',
      description:
        'Gemma 3 introduces multimodality, supporting vision-language input and text outputs, with context windows up to 128k tokens and support for over 140 languages.',
      flags: ['vision'],
      context_length: 131072,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'gemma3:12b',
      name: 'Gemma 3 12B',
      description:
        'Gemma 3 introduces multimodality, supporting vision-language input and text outputs, with context windows up to 128k tokens and support for over 140 languages.',
      flags: ['vision'],
      context_length: 131072,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'gemma3:4b',
      name: 'Gemma 3 4B',
      description:
        'Gemma 3 introduces multimodality, supporting vision-language input and text outputs, with context windows up to 128k tokens and support for over 140 languages.',
      flags: ['vision'],
      context_length: 131072,
      max_completion_tokens: 131072,
      variants: null,
    },
    {
      id: 'rnj-1:8b',
      name: 'Rnj-1 8B',
      description:
        'Rnj-1 is an 8B-parameter, dense, open-weight model family developed by Essential AI and trained from scratch with a focus on programming, math, and scientific reasoning.',
      flags: [],
      context_length: 32768,
      max_completion_tokens: 4096,
      variants: null,
    },
  ],
} satisfies DirectByokProvider;
