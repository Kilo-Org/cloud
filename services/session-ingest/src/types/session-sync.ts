import { z } from 'zod';

// Session ingest payload.
// Intentionally minimal validation: enforce only identity fields needed for compaction.
const storageKeySegmentSchema = z
  .string()
  .min(1)
  .refine(segment => !segment.includes('/') && !segment.includes('\u0000'), {
    message: 'storage key segments must not contain / or U+0000',
  });

export const SessionItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kilo_meta'),
    data: z.object({
      platform: z.string().min(1),
      orgId: z.uuid().optional(),
      gitUrl: z.string().max(2048).optional(),
      gitBranch: z.string().max(256).optional(),
    }),
  }),
  z.object({
    type: z.literal('session'),
    data: z.looseObject({}),
  }),
  z.object({
    type: z.literal('message'),
    data: z.looseObject({
      id: storageKeySegmentSchema,
    }),
  }),
  z.object({
    type: z.literal('part'),
    data: z.looseObject({
      id: storageKeySegmentSchema,
      messageID: storageKeySegmentSchema,
    }),
  }),
  z.object({
    type: z.literal('session_diff'),
    data: z.array(z.looseObject({})),
  }),
  z.object({
    type: z.literal('model'),
    data: z.array(
      z.looseObject({
        id: z.string().trim().min(1),
      })
    ),
  }),
  z.object({
    type: z.literal('session_open'),
    data: z.object({}),
  }),
  z.object({
    type: z.literal('session_close'),
    data: z.object({
      reason: z.enum(['completed', 'error', 'interrupted']),
    }),
  }),
  z.object({
    type: z.literal('session_status'),
    data: z.object({
      status: z.enum(['idle', 'busy', 'question', 'permission', 'retry']),
    }),
  }),
]);

export type SessionDataItem = z.infer<typeof SessionItemSchema>;
export type IngestBatch = SessionDataItem[];
