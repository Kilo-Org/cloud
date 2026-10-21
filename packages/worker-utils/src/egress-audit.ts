import { z } from 'zod';

export const EgressAuditRequestSchema = z.object({
  requestId: z.string().uuid().toLowerCase(),
  allocationRef: z.string().min(1).max(512),
  timestamp: z.string().datetime(),
  method: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/),
  hostname: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9._:[\]-]+$/),
  protocol: z.enum(['http:', 'https:']),
  port: z.number().int().min(1).max(65535),
  decision: z.enum(['allowed', 'denied']),
});

export const EgressAuditRecordSchema = EgressAuditRequestSchema.extend({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const GetEgressAuditInputSchema = z.object({
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const GetEgressAuditResponseSchema = z.object({
  records: z.array(EgressAuditRecordSchema).max(100),
  nextCursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});

export type EgressAuditRequest = z.infer<typeof EgressAuditRequestSchema>;
export type EgressAuditRecord = z.infer<typeof EgressAuditRecordSchema>;
export type GetEgressAuditInput = z.infer<typeof GetEgressAuditInputSchema>;
export type GetEgressAuditResponse = z.infer<typeof GetEgressAuditResponseSchema>;
