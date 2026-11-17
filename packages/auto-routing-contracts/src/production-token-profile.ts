import * as z from 'zod';

export const ProductionTokenProfileSchema = z.object({
  uncachedInputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
});
export type ProductionTokenProfile = z.infer<typeof ProductionTokenProfileSchema>;
