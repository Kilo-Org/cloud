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
      // Permissive on purpose, mirroring `SessionStatusSchema`: a producer may
      // report a status this worker does not know yet (`scheduled` today, others
      // later). A strict enum would fail `SessionItemSchema` and make
      // `validateAndParseIngestPayload` skip the whole item, so the status would
      // never reach `cli_sessions_v2.status` or the `session.status.updated`
      // event. Any string is relayed as-is rather than dropped or coerced to `idle`.
      status: z.string(),
      // Wake time for a `scheduled` session (ISO-8601). Absent for every other
      // status and when the producer omits it; null is tolerated like the stored
      // row schema, because a missing time must never drop the item.
      scheduledAt: z.string().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal('agent_notification'),
    data: z.object({
      // `id` participates in storage identities, so it shares the storage-key-segment
      // restrictions (no `/`, no U+0000). The RPC pair (notificationId) is the same string.
      id: storageKeySegmentSchema.max(64),
      message: z.string().trim().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal('session_pr_link'),
    data: z.object({
      // PR host (e.g. "github"), NOT the OS platform. All three keys are always sent;
      // any null field clears the whole link.
      platform: z.string().min(1).max(32).nullable(),
      prUrl: z.string().min(1).max(2048).nullable(),
      prNumber: z.number().int().positive().max(2_147_483_647).nullable(),
    }),
  }),
]);

export type SessionDataItem = z.infer<typeof SessionItemSchema>;
export type IngestBatch = SessionDataItem[];
