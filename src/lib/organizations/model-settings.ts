import * as z from 'zod';

export const ToolSchema = z.enum([
  'apply_diff',
  'apply_patch',
  'delete_file',
  'edit_file',
  'search_replace',
  'search_and_replace',
  'write_file',
  'write_to_file',
]);

export type Tool = z.infer<typeof ToolSchema>;

export const ModelSettingsSchema = z.object({
  included_tools: z.array(ToolSchema), // adds to the standard tool set
  excluded_tools: z.array(ToolSchema), // removes from the standard tool set
});

export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const VersionedSettingsSchema = z.record(z.string(), ModelSettingsSchema);

export type VersionedSettings = z.infer<typeof VersionedSettingsSchema>;

export const OpenCodePromptSchema = z.enum([
  'codex',
  'gemini',
  'beast',
  'anthropic',
  'trinity',
  'anthropic_without_todo',
]);

export type OpenCodePrompt = z.infer<typeof OpenCodePromptSchema>;

export const OpenCodeFamilySchema = z.enum(['claude', 'gpt', 'gemini', 'llama', 'mistral']);

export type OpenCodeFamily = z.infer<typeof OpenCodeFamilySchema>;

export const OpenCodeVariantSchema = z.object({
  verbosity: z.enum(['low', 'medium', 'high', 'max']).optional(),
  reasoning: z
    .object({
      enabled: z.boolean().optional(),
      effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).optional(),
    })
    .optional(),
});

export type OpenCodeVariant = z.infer<typeof OpenCodeVariantSchema>;

export const OpenCodeSettingsSchema = z.object({
  family: OpenCodeFamilySchema.optional(),
  prompt: OpenCodePromptSchema.optional(),
  variants: z.record(z.string(), OpenCodeVariantSchema).optional(),
});

export type OpenCodeSettings = z.infer<typeof OpenCodeSettingsSchema>;
