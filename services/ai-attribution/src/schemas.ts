import { z } from 'zod';

// Named limits for attribution tracking request validation, sized from the
// real client payloads: one entry per diff line, up to a whole rewritten file,
// and a SHA-1 hex line hash.
export const MAX_TRACK_LINE_ENTRIES = 2048;
export const MAX_TRACK_LINE_HASH_LENGTH = 128;
export const MAX_TRACK_ID_LENGTH = 256;
// The code-indexing storage layer accepts project identifiers up to this
// length, so the track schema must admit the same values.
export const MAX_TRACK_PROJECT_ID_LENGTH = 512;
export const MAX_TRACK_FILE_PATH_LENGTH = 1024;
// Upper bound on the path length accepted before normalization.
export const MAX_TRACK_RAW_PATH_LENGTH = MAX_TRACK_FILE_PATH_LENGTH * 4;
export const MAX_TRACK_BODY_BYTES = 256 * 1024;

// Attribution identity fields resolve to a Durable Object name, so each is a
// bounded canonical path.
export function canonicalizeAttributionPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

// Attribution identity fields resolve to a Durable Object name, so they are
// kept to a bounded canonical path with the character classes below.
const attributionPathSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(MAX_TRACK_RAW_PATH_LENGTH)
    .transform(canonicalizeAttributionPath)
    .pipe(
      z
        .string()
        .min(1)
        .max(maxLength)
        .refine(
          value =>
            [...value].every(character => {
              const codePoint = character.codePointAt(0) ?? 0;
              return codePoint > 0x1f && codePoint !== 0x7f;
            }),
          'must not contain control characters'
        )
    );

const trackLineSchema = z.object({
  line_number: z.number().int().min(0),
  line_hash: z.string().min(1).max(MAX_TRACK_LINE_HASH_LENGTH),
});

export type AttributionsTrackRequestBody = z.infer<typeof AttributionsTrackRequestBody>;
export const AttributionsTrackRequestBody = z.object({
  project_id: attributionPathSchema(MAX_TRACK_PROJECT_ID_LENGTH),
  branch: z.string().min(1).max(MAX_TRACK_ID_LENGTH),
  file_path: attributionPathSchema(MAX_TRACK_FILE_PATH_LENGTH),
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

// Admin reads resolve identity from the same fields, so they use the same
// path schema as tracking.
export type AdminAttributionsQueryParams = z.infer<typeof AdminAttributionsQueryParams>;
export const AdminAttributionsQueryParams = z.object({
  organization_id: z.string().min(1),
  project_id: attributionPathSchema(MAX_TRACK_PROJECT_ID_LENGTH),
  file_path: attributionPathSchema(MAX_TRACK_FILE_PATH_LENGTH),
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
  project_id: attributionPathSchema(MAX_TRACK_PROJECT_ID_LENGTH),
  file_path: attributionPathSchema(MAX_TRACK_FILE_PATH_LENGTH),
  attribution_id: z.coerce.number().int().positive(),
});
