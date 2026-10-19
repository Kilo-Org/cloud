import { z } from 'zod';

// Named limits for attribution tracking request validation, sized generously
// above real per-file client payloads.
export const MAX_TRACK_LINE_ENTRIES = 512;
export const MAX_TRACK_LINE_HASH_LENGTH = 128;
export const MAX_TRACK_ID_LENGTH = 256;
export const MAX_TRACK_FILE_PATH_LENGTH = 1024;
export const MAX_TRACK_BODY_BYTES = 256 * 1024;

// Attribution identity fields resolve to a Durable Object name, so they are
// kept to normalized relative paths with the character classes below.
const attributionPathSegmentSchema = z
  .string()
  .min(1)
  .max(MAX_TRACK_FILE_PATH_LENGTH)
  .refine(value => !value.startsWith('/'), 'must be a relative path')
  .refine(value => !value.includes('\\'), 'must not contain backslashes')
  // eslint-disable-next-line no-control-regex
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters')
  .refine(
    value => value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a normalized relative path'
  );

const trackLineSchema = z.object({
  line_number: z.number().int().min(0),
  line_hash: z.string().min(1).max(MAX_TRACK_LINE_HASH_LENGTH),
});

export type AttributionsTrackRequestBody = z.infer<typeof AttributionsTrackRequestBody>;
export const AttributionsTrackRequestBody = z.object({
  project_id: attributionPathSegmentSchema.max(MAX_TRACK_ID_LENGTH),
  branch: z.string().min(1).max(MAX_TRACK_ID_LENGTH),
  file_path: attributionPathSegmentSchema,
  status: z.enum(['accepted', 'rejected']),
  task_id: z.string().max(MAX_TRACK_ID_LENGTH).nullable(),
  lines_added: trackLineSchema.array().max(MAX_TRACK_LINE_ENTRIES),
  lines_removed: trackLineSchema.array().max(MAX_TRACK_LINE_ENTRIES),
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
