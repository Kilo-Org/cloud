import { z } from 'zod';

export const EgressAuditRequestSchema = z.object({
  requestId: z.string().uuid().toLowerCase(),
  allocationRef: z.string().min(1).max(512),
  timestamp: z.string().datetime(),
  // Absent means request scope. Request rows omit it so a reader on the previous
  // release, which parses rows strictly, still accepts them after a revert deploy.
  scope: z.enum(['request', 'connection']).optional(),
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

/** Records transport metadata only. Paths, query values and headers never enter an audit row. */
export function buildEgressAuditRequest(input: {
  requestId: string;
  allocationRef: string;
  timestamp: string;
  method: string;
  url: URL;
  decision: 'allowed' | 'denied';
  scope?: 'request' | 'connection';
}): EgressAuditRequest {
  return EgressAuditRequestSchema.parse({
    requestId: input.requestId,
    allocationRef: input.allocationRef,
    timestamp: input.timestamp,
    ...(input.scope === 'connection' ? { scope: 'connection' } : {}),
    method: input.method.slice(0, 32),
    hostname: input.url.hostname.slice(0, 253).replace(/[^a-zA-Z0-9._:[\]-]/g, '_'),
    protocol: input.url.protocol,
    port: Number(input.url.port || (input.url.protocol === 'https:' ? 443 : 80)),
    decision: input.decision,
  });
}
