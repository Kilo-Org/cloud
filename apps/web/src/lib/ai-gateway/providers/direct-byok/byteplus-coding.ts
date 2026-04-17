import {
  REASONING_VARIANTS_BINARY,
  REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
} from '@/lib/ai-gateway/providers/model-settings';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
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
} satisfies DirectByokProvider;
