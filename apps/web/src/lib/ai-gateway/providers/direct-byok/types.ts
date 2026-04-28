import * as z from 'zod';
import { OpenCodeVariantSchema } from '@kilocode/db/schema-types';
import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import type { CustomLlmProvider } from '@kilocode/db';

export const DirectByokModelFlagSchema = z.enum(['recommended', 'vision']);

export type DirectByokModelFlag = z.infer<typeof DirectByokModelFlagSchema>;

export const DirectByokModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  flags: z.array(DirectByokModelFlagSchema).readonly(),
  description: z.string(),
  context_length: z.number(),
  max_completion_tokens: z.number(),
  variants: z.record(z.string(), OpenCodeVariantSchema).nullable(),
});

export type DirectByokModel = z.infer<typeof DirectByokModelSchema>;

export type DirectByokProvider = {
  id: DirectUserByokInferenceProviderId;
  name: string;
  base_url: string;
  models: ReadonlyArray<DirectByokModel>;
  ai_sdk_provider: CustomLlmProvider;
  transformRequest(context: TransformRequestContext): void;
};

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';
