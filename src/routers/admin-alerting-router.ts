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
      if (error instanceof O11yRequestError) {
        throw new TRPCError({
          code: error.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR',
          message: error.message,
        });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch alerting config',
      });
    }
  }),
  updateConfig: adminProcedure.input(AlertingConfigSchema).mutation(async ({ input }) => {
    try {
      return await fetchO11yJson({
        path: '/alerting/config',
        schema: AlertingConfigResponseSchema,
        method: 'PUT',
        body: input,
        errorMessage: 'Failed to update alerting config',
        parseErrorMessage: 'Invalid alerting config response',
      });
    } catch (error) {
      if (error instanceof O11yRequestError) {
        throw new TRPCError({
          code: error.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR',
          message: error.message,
        });
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to update alerting config',
      });
    }
  }),
  deleteConfig: adminProcedure
    .input(z.object({ model: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await fetchO11yJson({
          path: '/alerting/config',
          schema: AlertingConfigDeleteResponseSchema,
          method: 'DELETE',
          searchParams: new URLSearchParams({ model: input.model }),
          errorMessage: 'Failed to delete alerting config',
          parseErrorMessage: 'Invalid delete response',
        });
      } catch (error) {
        if (error instanceof O11yRequestError) {
          throw new TRPCError({
            code: error.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR',
            message: error.message,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete alerting config',
        });
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
        if (error instanceof O11yRequestError) {
          throw new TRPCError({
            code: error.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR',
            message: error.message,
          });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch baseline' });
      }
    }),
});
