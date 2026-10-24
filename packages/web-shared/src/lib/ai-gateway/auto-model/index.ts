import type { OpenRouterReasoningConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  ORGANIZATION_AUTO_MODEL_ID,
  type OpenCodeSettings,
  type Verbosity,
} from '@kilocode/db/schema-types';
import {
  GEMMA_4_26B_A4B_IT_FREE_ID,
  GEMMA_4_26B_A4B_IT_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import {
  customRouterModelId,
  isCustomRouterModelId,
  type AutoRouter,
  type OwnerType,
} from '@kilocode/auto-routing-contracts';

export type AutoModelPricing = {
  prompt: string;
  completion: string;
  input_cache_read?: string;
  input_cache_write?: string;
};

export type AutoModel = {
  id: string;
  name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  pricing: AutoModelPricing;
  supports_images: boolean;
  supports_pdf: boolean;
  opencode_settings: OpenCodeSettings | undefined;
};

export type ResolvedAutoModel = {
  model: string;
  reasoning?: OpenRouterReasoningConfig;
  verbosity?: Verbosity;
};

const UNKNOWN_PRICING: AutoModelPricing = {
  prompt: '-1',
  completion: '-1',
};

export const KILO_AUTO_FRONTIER_MODEL: AutoModel = {
  id: 'kilo-auto/frontier',
  name: 'Auto Frontier',
  description: 'Highest performance and capability for any task.',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  pricing: UNKNOWN_PRICING,
  supports_images: true,
  supports_pdf: true,
  opencode_settings: undefined,
};

export const KILO_AUTO_FREE_MODEL: AutoModel = {
  id: 'kilo-auto/free',
  name: 'Auto Free',
  description:
    'Rotates through available free models. Limited capability and no credits required. [Learn more](https://kilo.ai/docs/code-with-ai/agents/auto-model)\n\n**Warning** Prompts may be logged by the upstream provider and used to improve their services. Not suitable for production or sensitive data workloads.',
  context_length: 256_000,
  max_completion_tokens: 32768,
  pricing: {
    prompt: '0',
    completion: '0',
    input_cache_read: '0',
    input_cache_write: '0',
  },
  supports_images: false,
  supports_pdf: false,
  opencode_settings: undefined,
};

export const KILO_AUTO_BALANCED_MODEL: AutoModel = {
  id: 'kilo-auto/balanced',
  name: 'Auto Balanced',
  description: 'Great balance of price and capability.',
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  pricing: UNKNOWN_PRICING,
  supports_images: true,
  supports_pdf: false,
  opencode_settings: undefined,
};

export const KILO_AUTO_SMALL_MODEL: AutoModel = {
  id: 'kilo-auto/small',
  name: 'Auto Small',
  description: 'Automatically routes your request to a small model.',
  context_length: 262144,
  max_completion_tokens: 32768,
  pricing: {
    prompt: '0.00000005',
    completion: '0.0000004',
    input_cache_read: '0.000000005',
  },
  supports_images: true,
  supports_pdf: false,
  opencode_settings: undefined,
};

export const AUTO_SMALL_TARGET_MODELS = {
  paid: GEMMA_4_26B_A4B_IT_ID,
  free: GEMMA_4_26B_A4B_IT_FREE_ID,
} as const;

export const KILO_AUTO_EFFICIENT_MODEL: AutoModel = {
  ...KILO_AUTO_BALANCED_MODEL,
  id: 'kilo-auto/efficient',
  name: 'Auto Efficient',
  description:
    'Routes each request to the cheapest model that gets the job done, based on continuously benchmarked accuracy and cost.',
};

export const ORG_AUTO_MODEL: AutoModel = {
  ...KILO_AUTO_BALANCED_MODEL,
  id: ORGANIZATION_AUTO_MODEL_ID,
  name: 'Organization Auto',
  description: "Routes requests using your organization's mode-specific model settings.",
};

export const ORGANIZATION_AUTO_TARGET_MODELS = [
  KILO_AUTO_FREE_MODEL.id,
  KILO_AUTO_SMALL_MODEL.id,
  KILO_AUTO_BALANCED_MODEL.id,
  KILO_AUTO_FRONTIER_MODEL.id,
] as const;

export const AUTO_MODELS = [
  KILO_AUTO_FRONTIER_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_SMALL_MODEL,
];

export function customRouterAutoModel(router: {
  scope: OwnerType;
  slug: string;
  name: string;
  baseRouter: AutoRouter;
}): AutoModel {
  const base =
    router.baseRouter === 'frontier' ? KILO_AUTO_FRONTIER_MODEL : KILO_AUTO_EFFICIENT_MODEL;
  return {
    ...base,
    id: customRouterModelId(router.scope, router.slug),
    name: router.name,
    description: `Custom auto router built on ${base.name}. Routes only to the models in its pool.`,
  };
}

export function isKiloAutoModel(model: string) {
  return (
    AUTO_MODELS.some(m => m.id === model) ||
    model === ORG_AUTO_MODEL.id ||
    isCustomRouterModelId(model)
  );
}
