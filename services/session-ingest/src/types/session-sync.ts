import { z } from 'zod';
import { fitsKiloSdkMessagesCursorId, messageIdSchema } from '@kilocode/session-ingest-contracts';

// Session ingest payload.
// Intentionally minimal validation: enforce only identity fields needed for compaction.
// Identity segments concatenate into `item_id` (see getItemIdentity), which is
// persisted and range-queried in Durable Object SQLite. The cap keeps the
// derived identity comfortably inside the platform string/row size limit
// (part identities are at most 256 + 1 + 256 bytes).
const storageKeySegmentSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(segment => !segment.includes('/') && !segment.includes('\u0000'), {
    message: 'storage key segments must not contain / or U+0000',
  });

// Status labels are short tokens (`idle`, `busy`, `question`, `scheduled`, …). The
// bound keeps the value set open while stopping one field from dominating the item's
// size and its RPC projection.
const SESSION_STATUS_MAX_CHARS = 256;
// An ISO-8601 timestamp, with room for every offset/precision variant.
const SESSION_STATUS_TIMESTAMP_MAX_CHARS = 64;

/**
 * Item-type roots that start an item id (`message/<id>`, `part/<messageId>/<id>`,
 * `agent_notification/<id>`). An identity segment equal to one of these roots is refused.
 */
const RESERVED_IDENTITY_SEGMENTS: Record<string, true> = {
  message: true,
  part: true,
  agent_notification: true,
};

function isNotReservedIdentitySegment(segment: string): boolean {
  return !Object.hasOwn(RESERVED_IDENTITY_SEGMENTS, segment);
}

const identitySegmentSchema = storageKeySegmentSchema.refine(isNotReservedIdentitySegment, {
  message: 'storage key segments must not repeat an item-type root',
});

// Message ids are re-emitted as history cursors and already have to satisfy
// the message id format when history is read, so ingest applies the whole
// cursor id contract rather than keeping its own.
const messageStorageKeySegmentSchema = messageIdSchema
  .refine(fitsKiloSdkMessagesCursorId, {
    message: 'message ids must fit the message cursor id byte limit',
  })
  .refine(isNotReservedIdentitySegment, {
    message: 'storage key segments must not repeat an item-type root',
  });

export const SessionItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kilo_meta'),
    data: z.object({
      // A short producer label (`cli`, `vscode`, `cloud-agent-web`, …). The bound is far
      // above every known label and above the 100-character cap the web create contract
      // applies to the same value, so no accepted label is lost, while one field can no
      // longer dominate the item's size (and its RPC projection).
      platform: z.string().min(1).max(256),
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
      id: messageStorageKeySegmentSchema,
    }),
  }),
  z.object({
    type: z.literal('part'),
    data: z.looseObject({
      id: storageKeySegmentSchema,
      messageID: identitySegmentSchema,
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
      // Only its length is bounded: status labels are short, and an unbounded string
      // could dominate the item's size and its RPC projection.
      status: z.string().max(SESSION_STATUS_MAX_CHARS),
      // Wake time for a `scheduled` session (ISO-8601). Absent for every other
      // status and when the producer omits it; null is tolerated like the stored
      // row schema, because a missing time must never drop the item.
      scheduledAt: z.string().max(SESSION_STATUS_TIMESTAMP_MAX_CHARS).nullable().optional(),
      occurredAt: z.string().datetime().optional(),
      previousStatus: z.string().max(SESSION_STATUS_MAX_CHARS).nullable().optional(),
      transitionId: z
        .string()
        .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('agent_notification'),
    data: z.object({
      // `id` participates in storage identities, so it shares the storage-key-segment
      // restrictions (no `/`, no U+0000) but keeps this service's tighter notification
      // contract. The RPC pair (notificationId) is the same string.
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
      // The branch the session pushed and the commit it pushed to that branch.
      // Optional so CLIs that predate the fields still parse. When `headSha` is
      // present the link is later shown only if GitHub reports that SHA as the
      // PR's head or as one of its commits; when it is absent the repo, head
      // repo, and head ref checks stand in — never a branch-name match alone.
      headRef: z.string().min(1).max(256).nullable().optional(),
      headSha: z.string().min(1).max(64).nullable().optional(),
    }),
  }),
]);

export type SessionDataItem = z.infer<typeof SessionItemSchema>;
export type IngestBatch = SessionDataItem[];
