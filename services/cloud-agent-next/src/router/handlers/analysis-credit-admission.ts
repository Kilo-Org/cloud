import { z } from 'zod';
import { validateBalanceOnly } from '../../balance-validation.js';
import { protectedProcedure } from '../auth.js';

export const analysisCreditAdmissionResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('admitted') }),
  z.object({ outcome: z.literal('insufficient_credits'), message: z.string() }),
  z.object({ outcome: z.literal('unavailable'), message: z.string() }),
]);

/**
 * Reads the credit admission that `initiateFromKilocodeSessionV2` will apply.
 *
 * A caller that performs paid work before it starts a session applies the same
 * admission rule first, so the payer decision is read once up front and again
 * by the mutation. This query is read-only - no session, no Durable Object, no
 * inference - and delegates to the same `validateBalanceOnly` the mutation
 * uses, so the payer rules, the minimum balance and the balance endpoint
 * selection stay in one place.
 *
 * Only a payer verdict is reported as such: 402 is insufficient credits. Every
 * other failure of the balance read, including an upstream refusal for an
 * organization the caller is not authorized for, is `unavailable`, so the
 * caller applies its existing retry classification rather than settling a
 * finding on a verdict this read cannot distinguish. The shared balance read
 * keeps one meaning for those failures because its other callers also gate
 * spending on it.
 */
export const getAnalysisCreditAdmission = protectedProcedure
  .input(z.object({ organizationId: z.string().uuid().optional() }).strict())
  .output(analysisCreditAdmissionResultSchema)
  .query(async ({ input, ctx }) => {
    const balance = await validateBalanceOnly(ctx.authToken, input.organizationId, ctx.env);
    if (balance.success) return { outcome: 'admitted' as const };
    return balance.status === 402
      ? { outcome: 'insufficient_credits' as const, message: balance.message }
      : { outcome: 'unavailable' as const, message: balance.message };
  });
