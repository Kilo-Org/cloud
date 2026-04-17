import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

const ProviderRolloutSchema = z.object({
  northflank: z.object({
    personalTrafficPercent: z.number().int().min(0).max(100),
    organizationTrafficPercent: z.number().int().min(0).max(100),
    enabledOrganizationIds: z.array(z.string().uuid()),
  }),
});

function extractProviderRolloutErrorMessage(err: KiloClawApiError): string {
  try {
    const body = JSON.parse(err.responseBody) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // not JSON
  }
  return `KiloClaw API error (${err.statusCode})`;
}

export const adminKiloclawProvidersRouter = createTRPCRouter({
  getRollout: adminProcedure.query(async () => {
    const client = new KiloClawInternalClient();
    return client.getProviderRollout();
  }),

  updateRollout: adminProcedure.input(ProviderRolloutSchema).mutation(async ({ input }) => {
    const client = new KiloClawInternalClient();
    try {
      return await client.updateProviderRollout(input);
    } catch (err) {
      if (err instanceof KiloClawApiError && err.statusCode === 400) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: extractProviderRolloutErrorMessage(err),
          cause: err,
        });
      }
      throw err;
    }
  }),
});
