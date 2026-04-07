import { COMPATIBLE_USER_AGENT, type DirectByokProvider } from '@/lib/providers/direct-byok/types';
import {
  REASONING_VARIANTS_BINARY,
  REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
} from '@/lib/providers/model-settings';
import { isReasoningExplicitlyDisabled } from '@/lib/providers/openrouter/request-helpers';

export default [
  {
    id: 'byteplus-coding',
    name: 'BytePlus Coding Plan',
    base_url: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    ai_sdk_provider: 'openai-compatible',
    transformRequest(context) {
      context.request.body.thinking = {
        type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
      };
    },
    models: [
      {
        id: 'bytedance-seed-code',
        name: 'Seed-Code',
        description:
          "ByteDance's latest code model has been deeply optimized for agentic programming tasks.",
        flags: ['recommended', 'vision'],
        context_length: 262144,
        max_completion_tokens: 32768,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'kimi-k2.5',
        name: 'Kimi-K2.5',
        description:
          'Open-source SoTA native multimodal model with text-only input (for now), stronger code/UI generation.',
        flags: ['recommended'],
        context_length: 262144,
        max_completion_tokens: 32768,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        description:
          "Z.ai's latest flagship model, enhanced programming capabilities and more stable multi-step reasoning/execution.",
        flags: ['recommended'],
        context_length: 204800,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS-120B',
        description:
          "OpenAI's open-weight model, 117B parameters with 5.1B active parameters for production, general purpose, high reasoning use cases.",
        flags: [],
        context_length: 131072,
        max_completion_tokens: 65536,
        variants: null,
      },
      {
        id: 'dola-seed-2.0-pro',
        name: 'Dola-Seed-2.0-Pro',
        description:
          'Focused on long-chain reasoning and stability in complex task execution, designed for complex real-world business scenarios.',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
      },
      {
        id: 'dola-seed-2.0-lite',
        name: 'Dola-Seed-2.0-Lite',
        description:
          'Balances generation quality and response speed, making it a strong general-purpose production model.',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
      },
    ],
  },
  {
    id: 'kimi-coding',
    name: 'Kimi Code',
    base_url: 'https://api.kimi.com/coding/v1',
    ai_sdk_provider: 'openai-compatible',
    transformRequest(context) {
      context.request.body.thinking = {
        type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
      };
      context.extraHeaders['user-agent'] = COMPATIBLE_USER_AGENT;
    },
    models: [
      {
        id: 'kimi-for-coding',
        name: 'Kimi for Coding',
        flags: ['recommended', 'vision'],
        context_length: 262144,
        max_completion_tokens: 32768,
        description:
          'Kimi Code is a premium subscription tier within the Kimi ecosystem, specifically engineered to empower developers with advanced AI capabilities for coding.',
        variants: REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
      },
    ],
  },
  {
    id: 'zai-coding',
    name: 'Z.ai Coding Plan',
    base_url: 'https://api.z.ai/api/coding/paas/v4',
    ai_sdk_provider: 'openai-compatible',
    transformRequest(context) {
      context.request.body.thinking = {
        type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
      };
    },
    models: [
      {
        id: 'glm-5-turbo',
        name: 'GLM-5 Turbo',
        description:
          'GLM-5 Turbo is a new model from Z.ai designed for fast inference and strong performance in agent-driven environments such as OpenClaw scenarios. It is deeply optimized for real-world agent workflows involving long execution chains, with improved complex instruction decomposition, tool use, scheduled and persistent execution, and overall stability across extended tasks.',
        flags: [],
        context_length: 202752,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        description:
          "GLM-5.1 is Z.ai's latest iteration of the flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows. Built for expert developers, it delivers production-grade performance on large-scale programming tasks, rivaling leading closed-source models. With advanced agentic planning, deep backend reasoning, and iterative self-correction, GLM-5.1 moves beyond code generation to full-system construction and autonomous execution.",
        flags: ['recommended'],
        context_length: 204800,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-5',
        name: 'GLM-5',
        description:
          "GLM-5 is Z.ai's flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows. Built for expert developers, it delivers production-grade performance on large-scale programming tasks, rivaling leading closed-source models. With advanced agentic planning, deep backend reasoning, and iterative self-correction, GLM-5 moves beyond code generation to full-system construction and autonomous execution.",
        flags: [],
        context_length: 204800,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        description:
          "GLM-4.7 is Z.ai's latest flagship model, featuring upgrades in two key areas: enhanced programming capabilities and more stable multi-step reasoning/execution. It demonstrates significant improvements in executing complex agent tasks while delivering more natural conversational experiences and superior front-end aesthetics.",
        flags: [],
        context_length: 204800,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.7-flash',
        name: 'GLM-4.7-Flash',
        description:
          'As a 30B-class SOTA model, GLM-4.7-Flash offers a new option that balances performance and efficiency. It is further optimized for agentic coding use cases, strengthening coding capabilities, long-horizon task planning, and tool collaboration, and has achieved leading performance among open-source models of the same size on several current public benchmark leaderboards.',
        flags: [],
        context_length: 200000,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.7-flashx',
        name: 'GLM-4.7-FlashX',
        description:
          'GLM-4.7-FlashX is an enhanced variant of GLM-4.7-Flash, offering higher throughput and improved performance for agentic coding workflows. It combines the compact 30B-class efficiency of the Flash series with additional capacity for complex instruction following and multi-step tool use.',
        flags: [],
        context_length: 200000,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.6',
        name: 'GLM-4.6',
        description:
          'GLM-4.6 brings several key improvements over GLM-4.5: an expanded context window from 128K to 200K tokens for more complex agentic tasks; superior coding performance on code benchmarks and better real-world performance in agentic coding applications; advanced reasoning with tool use support during inference; stronger capability in tool-use and search-based agents; and refined writing that aligns more naturally with human preferences in style and readability.',
        flags: [],
        context_length: 204800,
        max_completion_tokens: 131072,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.6v',
        name: 'GLM-4.6V',
        description:
          'GLM-4.6V is a large multimodal model designed for high-fidelity visual understanding and long-context reasoning across images, documents, and mixed media. It supports up to 128K tokens, processes complex page layouts and charts directly as visual inputs, and integrates native multimodal function calling to connect perception with downstream tool execution. The model also enables interleaved image-text generation and UI reconstruction workflows, including screenshot-to-HTML synthesis and iterative visual editing.',
        flags: ['vision'],
        context_length: 128000,
        max_completion_tokens: 32768,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.5',
        name: 'GLM-4.5',
        description:
          'GLM-4.5 is Z.ai\'s flagship foundation model purpose-built for agent-based applications. It leverages a Mixture-of-Experts (MoE) architecture and supports a context length of up to 128K tokens. GLM-4.5 delivers significantly enhanced capabilities in reasoning, code generation, and agent alignment, with a hybrid inference mode offering a "thinking mode" for complex reasoning and tool use and a "non-thinking mode" optimized for instant responses.',
        flags: [],
        context_length: 131072,
        max_completion_tokens: 98304,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        description:
          'GLM-4.5-Air is the lightweight variant of Z.ai\'s latest flagship model family, purpose-built for agent-centric applications. Like GLM-4.5, it adopts the Mixture-of-Experts (MoE) architecture but with a more compact parameter size. GLM-4.5-Air supports hybrid inference modes, offering a "thinking mode" for advanced reasoning and tool use and a "non-thinking mode" for real-time interaction.',
        flags: [],
        context_length: 131072,
        max_completion_tokens: 98304,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.5-flash',
        name: 'GLM-4.5-Flash',
        description:
          'GLM-4.5-Flash is the free, high-speed variant of the GLM-4.5 model family, optimized for low-latency agentic coding tasks. It shares the MoE architecture of GLM-4.5 in a smaller, faster form factor, retaining reasoning and tool-use capabilities at no cost.',
        flags: [],
        context_length: 131072,
        max_completion_tokens: 98304,
        variants: REASONING_VARIANTS_BINARY,
      },
      {
        id: 'glm-4.5v',
        name: 'GLM-4.5V',
        description:
          'GLM-4.5V is a vision-language foundation model for multimodal agent applications. Built on a Mixture-of-Experts (MoE) architecture with 106B parameters and 12B activated parameters, it achieves state-of-the-art results in video understanding, image Q&A, OCR, and document parsing, with strong gains in front-end web coding, grounding, and spatial reasoning. It supports a hybrid inference mode with "thinking" and "non-thinking" options.',
        flags: ['vision'],
        context_length: 64000,
        max_completion_tokens: 16384,
        variants: REASONING_VARIANTS_BINARY,
      },
    ],
  },
] satisfies ReadonlyArray<DirectByokProvider>;
