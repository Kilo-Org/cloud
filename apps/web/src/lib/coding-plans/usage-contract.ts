import * as z from 'zod';

export const CodingPlanQuotaPeriodSchema = z.object({
  unit: z.enum(['hour', 'day', 'week', 'month']),
  value: z.number().int().positive(),
});

export const CodingPlanQuotaWindowSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  remainingPercent: z.number().finite().nonnegative(),
  resetsAt: z.iso.datetime(),
  startsAt: z.iso.datetime().optional(),
  period: CodingPlanQuotaPeriodSchema,
});

export const CodingPlanQuotaWindowsSchema = z
  .array(CodingPlanQuotaWindowSchema)
  .min(1)
  .max(16)
  .superRefine((windows, ctx) => {
    const ids = new Set<string>();
    for (const [index, window] of windows.entries()) {
      if (ids.has(window.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Quota window IDs must be unique.',
          path: [index, 'id'],
        });
      }
      ids.add(window.id);
    }
  });

export type CodingPlanQuotaWindow = z.infer<typeof CodingPlanQuotaWindowSchema>;
