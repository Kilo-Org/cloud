import * as z from 'zod/v4';

export const OpenRouterErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.union([z.string(), z.number()]).nullable().optional().default(null),
        message: z.string(),
        type: z.string().nullable().optional().default(null),
        param: z.any().nullable().optional().default(null),
      })
      .passthrough(),
  })
  .passthrough();
