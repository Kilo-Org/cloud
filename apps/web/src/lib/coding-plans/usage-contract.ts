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

export const CodingPlanUsageSnapshotSchema = z.object({
  fetchedAt: z.iso.datetime(),
  windows: CodingPlanQuotaWindowsSchema,
});

export type CodingPlanUsageSnapshot = z.infer<typeof CodingPlanUsageSnapshotSchema>;

export type CodingPlanUsageErrorCode =
  | 'configuration'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid_response'
  | 'application';

// Thrown by provider usage adapters. The message is a safe generic user-facing
// string; `code` is a non-secret failure category for logging.
export class CodingPlanUsageError extends Error {
  readonly code: CodingPlanUsageErrorCode;

  constructor(code: CodingPlanUsageErrorCode) {
    super('Coding Plan usage is temporarily unavailable.');
    this.name = 'CodingPlanUsageError';
    this.code = code;
  }
}
