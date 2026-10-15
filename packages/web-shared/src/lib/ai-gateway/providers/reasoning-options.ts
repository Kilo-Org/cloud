import * as z from 'zod';
import {
  OpenCodeSettingsSchema,
  ReasoningEffortSchema,
  type OpenCodeSettings,
  type OpenCodeVariant,
  type ReasoningEffort,
} from '@kilocode/db/schema-types';

// models.dev `reasoning_options` format, consumed by Kilo CLI v2 to build its own
// per-protocol reasoning variants. https://github.com/anomalyco/models.dev
export const ReasoningOptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('effort'), values: z.array(ReasoningEffortSchema) }),
  z.object({ type: z.literal('toggle') }),
  z.object({
    type: z.literal('budget_tokens'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);

export type ReasoningOption = z.infer<typeof ReasoningOptionSchema>;

export const CatalogOpenCodeSettingsSchema = OpenCodeSettingsSchema.extend({
  reasoning_options: z.array(ReasoningOptionSchema).optional(),
});

export type CatalogOpenCodeSettings = z.infer<typeof CatalogOpenCodeSettingsSchema>;

// The binary variant sets name their enabled variant `thinking` rather than after its effort.
const TOGGLE_ON_VARIANT = 'thinking';

function variantEffort(variant: OpenCodeVariant): ReasoningEffort | undefined {
  return variant.reasoning?.enabled === false ? 'none' : variant.reasoning?.effort;
}

/**
 * Derives models.dev `reasoning_options` from the OpenRouter-shaped `variants`. Returns undefined
 * when there are no variants or any variant has no expressible effort, so clients fall back to
 * their own defaults instead of receiving `[]`, which means "no reasoning control".
 */
export function getReasoningOptions(
  variants: OpenCodeSettings['variants']
): ReasoningOption[] | undefined {
  const entries = Object.entries(variants ?? {}).map(([name, variant]) => ({
    name,
    effort: variantEffort(variant),
  }));
  if (entries.length === 0 || entries.some(entry => entry.effort === undefined)) {
    return undefined;
  }
  const efforts = new Set(entries.map(entry => entry.effort));
  const isToggle =
    efforts.has('none') &&
    entries.some(entry => entry.name === TOGGLE_ON_VARIANT) &&
    entries.every(entry => entry.name === TOGGLE_ON_VARIANT || entry.effort === 'none');
  if (isToggle) {
    return [{ type: 'toggle' }];
  }
  return [
    { type: 'effort', values: ReasoningEffortSchema.options.filter(effort => efforts.has(effort)) },
  ];
}

export function withReasoningOptions(settings: OpenCodeSettings): CatalogOpenCodeSettings {
  const reasoning_options = getReasoningOptions(settings.variants);
  return reasoning_options ? { ...settings, reasoning_options } : settings;
}
