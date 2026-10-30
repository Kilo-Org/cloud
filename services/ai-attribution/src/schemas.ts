import { z } from 'zod';

// Named limits for attribution tracking request validation, sized from the
// real client payloads: one entry per diff line, up to a whole rewritten file.
// The line hash is the SHA-1 hex digest of the line, which is what both the
// client and the web matcher compute.
export const MAX_TRACK_LINE_ENTRIES = 2048;
const LINE_HASH_PATTERN = /^[0-9a-f]{40}$/;
export const MAX_TRACK_ID_LENGTH = 256;
// The code-indexing storage layer accepts project identifiers up to this
// length, so the track schema must admit the same values.
export const MAX_TRACK_PROJECT_ID_LENGTH = 512;
export const MAX_TRACK_FILE_PATH_LENGTH = 1024;
export const MAX_TRACK_BODY_BYTES = 256 * 1024;

const trackLineSchema = z.object({
  line_number: z.number().int().min(0),
  line_hash: z.string().regex(LINE_HASH_PATTERN, 'Expected a SHA-1 hex line hash'),
});

export type AttributionsTrackRequestBody = z.infer<typeof AttributionsTrackRequestBody>;
export const AttributionsTrackRequestBody = z.object({
  // project_id and file_path name the Durable Object, so they are kept exactly
  // as the client sends them and only bounded in length.
  project_id: z.string().min(1).max(MAX_TRACK_PROJECT_ID_LENGTH),
  branch: z.string().min(1).max(MAX_TRACK_ID_LENGTH),
  file_path: z.string().min(1).max(MAX_TRACK_FILE_PATH_LENGTH),
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

// Admin reads resolve identity from the same fields, so they are left exactly
// as stored.
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
