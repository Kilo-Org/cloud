import { type Effort } from '@kilocode/harness-sdk';
import { z } from 'zod';

/** Every effort the SDK takes, for checking a string from the catalog or the store. */
export const EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly Effort[];

/** The efforts a custom backend offers when its model is marked as reasoning. */
export const BACKEND_EFFORT_VARIANTS: readonly Effort[] = ['low', 'medium', 'high'];

/** The thinking switch of a downloaded model whose template can think. */
export const THINKING_SWITCH_VARIANTS = ['off', 'on'] as const;

/** What the thinking switch asks for. Any effort but `none` turns thinking on. */
const SWITCH_EFFORTS = { off: 'none', on: 'high' } as const satisfies Record<
  (typeof THINKING_SWITCH_VARIANTS)[number],
  Effort
>;

const catalogVariant = z.object({ reasoning: z.object({ effort: z.enum(EFFORTS) }) });

/** An effort the store or a setting names, or null for anything else. */
export function effortOf(value: unknown): Effort | null {
  return EFFORTS.find(effort => effort === value) ?? null;
}

/** The effort each catalog variant asks for, read from the variant's own settings. */
export function catalogVariantEfforts(
  variants: Readonly<Record<string, unknown>>
): Record<string, Effort> {
  return Object.fromEntries(
    Object.entries(variants).flatMap(([name, settings]) => {
      const parsed = catalogVariant.safeParse(settings);
      return parsed.success ? [[name, parsed.data.reasoning.effort]] : [];
    })
  );
}

/** The variants a model offers, and what the catalog says each asks for. */
export type EffortChoices = {
  readonly variants: readonly string[];
  readonly efforts?: Readonly<Partial<Record<string, Effort>>>;
};

/**
 * The effort a picked variant asks for. Null when the model offers no such
 * variant, so a model that takes no effort is never sent one.
 */
export function effortOfVariant(choices: EffortChoices, variant: string): Effort | null {
  if (!choices.variants.includes(variant)) {
    return null;
  }
  const switched = THINKING_SWITCH_VARIANTS.find(name => name === variant);
  return (
    choices.efforts?.[variant] ??
    effortOf(variant) ??
    (switched === undefined ? null : SWITCH_EFFORTS[switched])
  );
}

/** The variant that shows a chat's effort, or '' when no variant asks for it. */
export function variantOfEffort(choices: EffortChoices, effort: Effort | null): string {
  if (effort === null) {
    return '';
  }
  return choices.variants.find(variant => effortOfVariant(choices, variant) === effort) ?? '';
}
