import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { z } from 'zod';

type BotModelIntegration = {
  metadata: unknown;
};

const BotModelSlugSchema = z.string().trim().min(1);

const BotThinkingEffortSchema = z
  .string()
  .trim()
  .max(50)
  .regex(/^[a-zA-Z]+$/)
  .nullable()
  .optional();

export type BotModelSettings = {
  modelSlug: string;
  thinkingEffort: string | null;
};

export function resolveBotModelSettings(
  integration: BotModelIntegration | null | undefined
): BotModelSettings {
  const modelParsed = BotModelSlugSchema.safeParse(
    (integration?.metadata as Record<string, unknown> | null)?.model_slug
  );
  const effortParsed = BotThinkingEffortSchema.safeParse(
    (integration?.metadata as Record<string, unknown> | null)?.thinking_effort
  );
  if (!modelParsed.success) return { modelSlug: DEFAULT_BOT_MODEL, thinkingEffort: null };

  return {
    modelSlug: modelParsed.data,
    thinkingEffort: effortParsed.success ? effortParsed.data?.trim() || null : null,
  };
}

export function resolveBotModelSlug(integration: BotModelIntegration | null | undefined): string {
  return resolveBotModelSettings(integration).modelSlug;
}

export function resolveBotThinkingEffort(
  integration: BotModelIntegration | null | undefined
): string | null {
  return resolveBotModelSettings(integration).thinkingEffort;
}
