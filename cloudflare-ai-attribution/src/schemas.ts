import { z } from 'zod';

export type AttributionsTrackRequestBody = z.infer<typeof AttributionsTrackRequestBody>;
export const AttributionsTrackRequestBody = z.object({
  project_id: z.string(),
  branch: z.string(),
  file_path: z.string(),
  status: z.enum(['accepted', 'rejected']),
  task_id: z.string().nullable(),
  lines_added: z
    .object({
      line_number: z.number().int(),
      line_hash: z.string(),
    })
    .array(),
  lines_removed: z
    .object({
      line_number: z.number().int(),
      line_hash: z.string(),
    })
    .array(),
});

export type OrganizationJWTPayload = z.infer<typeof OrganizationJWTPayload>;
export const OrganizationJWTPayload = z.object({
  version: z.literal(3),
  kiloUserId: z.string(),
  organizationId: z.string(),
  organizationRole: z.enum(['owner', 'member']),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type AdminAttributionsQueryParams = z.infer<typeof AdminAttributionsQueryParams>;
export const AdminAttributionsQueryParams = z.object({
  organization_id: z.string().min(1),
  project_id: z.string().min(1),
  file_path: z.string().min(1),
  branch: z.string().min(1).optional(),
});

export type AttributionEventResponse = z.infer<typeof AttributionEventResponse>;
export const AttributionEventResponse = z.object({
  id: z.number(),
  taskId: z.string().nullable(),
  lineHashes: z.array(z.string()),
});

export type AdminDeleteAttributionParams = z.infer<typeof AdminDeleteAttributionParams>;
export const AdminDeleteAttributionParams = z.object({
  organization_id: z.string().min(1),
  project_id: z.string().min(1),
  file_path: z.string().min(1),
  attribution_id: z.coerce.number().int().positive(),
});
