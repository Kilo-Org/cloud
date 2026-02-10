import { z } from 'zod';

// Session ingest payload.
// Intentionally minimal validation: enforce only identity fields needed for compaction.
export const SessionItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kilo_meta'),
    data: z.object({
      platform: z.string().min(1),
      orgId: z.uuid().optional(),
    }),
  }),
  z.object({
    type: z.literal('session'),
    data: z.looseObject({}),
  }),
  z.object({
    type: z.literal('message'),
    data: z.looseObject({
      id: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal('part'),
    data: z.looseObject({
      id: z.string().min(1),
      messageID: z.string().min(1),
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
]);

export const SessionSyncInputSchema = z.object({
  data: z.array(SessionItemSchema),
});

export type SessionSyncInput = z.infer<typeof SessionSyncInputSchema>;
export type IngestBatch = SessionSyncInput['data'];
export type SessionDataItem = SessionSyncInput['data'][number];
