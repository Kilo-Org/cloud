import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import type { CustomLlmProvider, OpenCodeVariant } from '@kilocode/db';

export type DirectByokModelFlag = 'recommended' | 'vision';

export type DirectByokModel = {
  id: string;
  name: string;
  flags: ReadonlyArray<DirectByokModelFlag>;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  variants: Record<string, OpenCodeVariant> | null;
};

export type DirectByokProvider = {
  id: DirectUserByokInferenceProviderId;
  name: string;
  base_url: string;
  models: ReadonlyArray<DirectByokModel>;
  ai_sdk_provider: CustomLlmProvider;
  transformRequest(context: TransformRequestContext): void;
};

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';
