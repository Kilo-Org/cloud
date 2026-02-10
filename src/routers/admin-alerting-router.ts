import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { z } from 'zod';
import { fetchO11yJson, O11yRequestError } from '@/lib/o11y-client';
import { normalizeModelId } from '@/lib/model-utils';
import { TRPCError } from '@trpc/server';

const AlertingConfigSchema = z.object({
  model: z.string().min(1),
  enabled: z.boolean(),
  errorRateSlo: z.number().gt(0).lt(1),
  minRequestsPerWindow: z.number().int().positive(),
});

const AlertingConfigsResponseSchema = z.object({
  success: z.boolean(),
  configs: z.array(AlertingConfigSchema),
});

const AlertingConfigResponseSchema = z.object({
  success: z.boolean(),
  config: AlertingConfigSchema.extend({ updatedAt: z.string().min(1) }),
});

const AlertingConfigDeleteResponseSchema = z.object({
  success: z.boolean(),
});

const AlertingBaselineSchema = z.object({
  model: z.string(),
  errorRate1d: z.number(),
  errorRate3d: z.number(),
  errorRate7d: z.number(),
  requests1d: z.number(),
  requests3d: z.number(),
  requests7d: z.number(),
});

const AlertingBaselineResponseSchema = z.object({
  success: z.boolean(),
  baseline: AlertingBaselineSchema.nullable(),
});

// --- TTFB alerting schemas ---

const TtfbAlertingConfigSchema = z.object({
  model: z.string().min(1),
  enabled: z.boolean(),
  ttfbThresholdMs: z.number().int().positive(),
  ttfbSlo: z.number().gt(0).lt(1),
  minRequestsPerWindow: z.number().int().positive(),
});

const TtfbAlertingConfigsResponseSchema = z.object({
  success: z.boolean(),
  configs: z.array(TtfbAlertingConfigSchema),
});

const TtfbAlertingConfigResponseSchema = z.object({
  success: z.boolean(),
  config: TtfbAlertingConfigSchema.extend({ updatedAt: z.string().min(1) }),
});

const TtfbBaselineSchema = z.object({
  model: z.string(),
  p50Ttfb3d: z.number(),
  p95Ttfb3d: z.number(),
  p99Ttfb3d: z.number(),
  requests3d: z.number(),
});

const TtfbBaselineResponseSchema = z.object({
  success: z.boolean(),
  baseline: TtfbBaselineSchema.nullable(),
});

function wrapO11yError(error: unknown, fallbackMessage: string): never {
  if (error instanceof O11yRequestError) {
    throw new TRPCError({
      code: error.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR',
      message: error.message,
    });
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: fallbackMessage });
}

export const adminAlertingRouter = createTRPCRouter({
  listConfigs: adminProcedure.query(async () => {
    try {
      return await fetchO11yJson({
        path: '/alerting/config',
        schema: AlertingConfigsResponseSchema,
        errorMessage: 'Failed to fetch alerting config',
        parseErrorMessage: 'Invalid alerting config response',
      });
    } catch (error) {
      wrapO11yError(error, 'Failed to fetch alerting config');
    }
  }),
  updateConfig: adminProcedure.input(AlertingConfigSchema).mutation(async ({ input }) => {
    const normalized = { ...input, model: normalizeModelId(input.model) };
    try {
      return await fetchO11yJson({
        path: '/alerting/config',
        schema: AlertingConfigResponseSchema,
        method: 'PUT',
        body: normalized,
        errorMessage: 'Failed to update alerting config',
        parseErrorMessage: 'Invalid alerting config response',
      });
    } catch (error) {
      wrapO11yError(error, 'Failed to update alerting config');
    }
  }),
  deleteConfig: adminProcedure
    .input(z.object({ model: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const model = normalizeModelId(input.model);
      try {
        return await fetchO11yJson({
          path: '/alerting/config',
          schema: AlertingConfigDeleteResponseSchema,
          method: 'DELETE',
          searchParams: new URLSearchParams({ model }),
          errorMessage: 'Failed to delete alerting config',
          parseErrorMessage: 'Invalid delete response',
        });
      } catch (error) {
        wrapO11yError(error, 'Failed to delete alerting config');
      }
    }),
  getBaseline: adminProcedure
    .input(z.object({ model: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await fetchO11yJson({
          path: '/alerting/baseline',
          searchParams: new URLSearchParams({ model: normalizeModelId(input.model) }),
          schema: AlertingBaselineResponseSchema,
          errorMessage: 'Failed to fetch baseline',
          parseErrorMessage: 'Invalid baseline response',
        });
      } catch (error) {
        wrapO11yError(error, 'Failed to fetch baseline');
      }
    }),

  // --- TTFB alerting procedures ---

  listTtfbConfigs: adminProcedure.query(async () => {
    try {
      return await fetchO11yJson({
        path: '/alerting/ttfb-config',
        schema: TtfbAlertingConfigsResponseSchema,
        errorMessage: 'Failed to fetch TTFB alerting config',
        parseErrorMessage: 'Invalid TTFB alerting config response',
      });
    } catch (error) {
      wrapO11yError(error, 'Failed to fetch TTFB alerting config');
    }
  }),
  updateTtfbConfig: adminProcedure.input(TtfbAlertingConfigSchema).mutation(async ({ input }) => {
    const normalized = { ...input, model: normalizeModelId(input.model) };
    try {
      return await fetchO11yJson({
        path: '/alerting/ttfb-config',
        schema: TtfbAlertingConfigResponseSchema,
        method: 'PUT',
        body: normalized,
        errorMessage: 'Failed to update TTFB alerting config',
        parseErrorMessage: 'Invalid TTFB alerting config response',
      });
    } catch (error) {
      wrapO11yError(error, 'Failed to update TTFB alerting config');
    }
  }),
  deleteTtfbConfig: adminProcedure
    .input(z.object({ model: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const model = normalizeModelId(input.model);
      try {
        return await fetchO11yJson({
          path: '/alerting/ttfb-config',
          schema: AlertingConfigDeleteResponseSchema,
          method: 'DELETE',
          searchParams: new URLSearchParams({ model }),
          errorMessage: 'Failed to delete TTFB alerting config',
          parseErrorMessage: 'Invalid delete response',
        });
      } catch (error) {
        wrapO11yError(error, 'Failed to delete TTFB alerting config');
      }
    }),
  getTtfbBaseline: adminProcedure
    .input(z.object({ model: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await fetchO11yJson({
          path: '/alerting/ttfb-baseline',
          searchParams: new URLSearchParams({ model: normalizeModelId(input.model) }),
          schema: TtfbBaselineResponseSchema,
          errorMessage: 'Failed to fetch TTFB baseline',
          parseErrorMessage: 'Invalid TTFB baseline response',
        });
      } catch (error) {
        wrapO11yError(error, 'Failed to fetch TTFB baseline');
      }
    }),
});
