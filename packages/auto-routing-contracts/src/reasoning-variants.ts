import * as z from 'zod';
import { REASONING_EFFORT_BANDS } from './reasoning';

// These are the reasoning controls supported by the Kilo catalog's OpenCode variants: the
// routing effort bands plus three controls the router itself never emits — `none` (reasoning
// off) and the `xhigh` and `max` budget tiers.
export const BenchmarkCatalogVariantsSchema = z.record(
  z.string().trim().min(1),
  z.object({
    reasoning: z
      .object({
        enabled: z.boolean().optional(),
        effort: z.enum(['none', ...REASONING_EFFORT_BANDS, 'xhigh', 'max']).optional(),
      })
      .optional(),
  })
);

export function getReasoningVariantKeys(
  variants: z.infer<typeof BenchmarkCatalogVariantsSchema> | undefined
): string[] {
  return Object.entries(variants ?? {})
    .filter(
      ([, variant]) =>
        variant.reasoning?.enabled !== undefined || variant.reasoning?.effort !== undefined
    )
    .map(([key]) => key);
}
