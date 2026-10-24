import { z } from 'zod';

export const customerBillingFailureSchema = z
  .object({
    code: z.enum(['INSUFFICIENT_CREDITS', 'COMPUTE_STOPPING', 'BILLING_UNAVAILABLE']),
    payer: z.object({ type: z.enum(['user', 'org']), id: z.string().min(1) }).strict(),
    retryable: z.boolean(),
    remainingMicrodollars: z.number().int().nonnegative().optional(),
    minimumRequiredMicrodollars: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CustomerBillingFailure = z.infer<typeof customerBillingFailureSchema>;
