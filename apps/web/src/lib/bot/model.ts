import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { z } from 'zod';

type BotModelIntegration = {
  metadata: unknown;
};

const BotModelMetadataSchema = z
  .object({
    model_slug: z.string().trim().min(1),
  })
  .passthrough();

export function resolveBotModelSlug(integration: BotModelIntegration | null | undefined): string {
  const parsed = BotModelMetadataSchema.safeParse(integration?.metadata);
  if (!parsed.success) return DEFAULT_BOT_MODEL;

  return parsed.data.model_slug;
}
