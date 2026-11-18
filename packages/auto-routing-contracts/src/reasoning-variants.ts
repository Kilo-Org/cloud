import * as z from 'zod';

// These are the reasoning controls supported by the Kilo catalog's OpenCode variants.
export const BenchmarkCatalogVariantsSchema = z.record(
  z.string().trim().min(1),
  z.object({
    reasoning: z
      .object({
        enabled: z.boolean().optional(),
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
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
