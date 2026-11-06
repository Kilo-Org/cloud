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
  const metadata = integration?.metadata as Record<string, unknown> | null;
  const modelParsed = BotModelSlugSchema.safeParse(metadata?.model_slug);
  const effortParsed = BotThinkingEffortSchema.safeParse(metadata?.thinking_effort);
  const thinkingEffort = effortParsed.success ? effortParsed.data?.trim() || null : null;

  // Keep a stored effort alongside the default model: the read path surfaces
  // it and the bot applies it to the default model, so both agree.
  if (!modelParsed.success) return { modelSlug: DEFAULT_BOT_MODEL, thinkingEffort };

  return { modelSlug: modelParsed.data, thinkingEffort };
}
