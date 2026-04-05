import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

// Basic shape validation only — the worker validates region codes against
// the full enum allowlist (ALL_VALID_REGIONS) and returns structured errors.
const UpdateRegionsSchema = z.object({
  regions: z.array(z.string()).min(2, 'At least 2 regions required'),
});

/**
 * Extract a human-readable error message from a KiloClawApiError response body.
 * The worker returns `{ error: "...", details: { regions: ["..."] } }` on validation failures.
 */
function extractRegionsErrorMessage(err: KiloClawApiError): string {
  try {
    const body = JSON.parse(err.responseBody) as {
      error?: string;
      details?: Record<string, string[]>;
    };
    const fieldErrors = body.details ? Object.values(body.details).flat() : [];
    if (fieldErrors.length > 0) return fieldErrors.join('; ');
    if (body.error) return body.error;
  } catch {
    // not JSON
  }
  return `KiloClaw API error (${err.statusCode})`;
}

export const adminKiloclawRegionsRouter = createTRPCRouter({
  getRegions: adminProcedure.query(async () => {
    const client = new KiloClawInternalClient();
    return client.getRegions();
  }),

  updateRegions: adminProcedure.input(UpdateRegionsSchema).mutation(async ({ input }) => {
    const client = new KiloClawInternalClient();
    try {
      return await client.updateRegions(input.regions);
    } catch (err) {
      if (err instanceof KiloClawApiError && err.statusCode === 400) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: extractRegionsErrorMessage(err),
          cause: err,
        });
      }
      throw err;
    }
  }),
});
