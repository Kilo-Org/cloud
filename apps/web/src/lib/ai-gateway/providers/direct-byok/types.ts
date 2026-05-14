import * as z from 'zod';
import { OpenCodeVariantSchema } from '@kilocode/db/schema-types';
import type { DirectByokProviderMetaId } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import type { CustomLlmProvider } from '@kilocode/db';

export const DirectByokModelFlagSchema = z.enum(['recommended', 'vision']);

export type DirectByokModelFlag = z.infer<typeof DirectByokModelFlagSchema>;

export const DirectByokModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  flags: z.array(DirectByokModelFlagSchema).readonly().optional(),
  context_length: z.number(),
  max_completion_tokens: z.number(),
  variants: z.preprocess(
    v => v ?? undefined,
    z.record(z.string(), OpenCodeVariantSchema).optional()
  ),
});

export const DirectByokModelArraySchema = z.array(DirectByokModelSchema);

export type DirectByokModel = z.infer<typeof DirectByokModelSchema>;

export type DirectByokProvider = {
  id: DirectByokProviderMetaId;
  base_url: string;
  models: () => Promise<ReadonlyArray<DirectByokModel>>;
  ai_sdk_provider: CustomLlmProvider;
  transformRequest(context: TransformRequestContext): void;
};

export const COMPATIBLE_USER_AGENT = 'Kilo-Code/5.12';
