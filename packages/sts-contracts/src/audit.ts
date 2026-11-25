import { z } from 'zod';

/**
 * Audit events use a CloudEvents 1.0 envelope with an OCSF payload (design section 8.2).
 * No event ever carries a token value, a secret value, a connection string, or a key.
 */

/** OCSF classes in use. */
export const OCSF_CLASS = {
  authentication: 3002,
  accountChange: 3001,
  apiActivity: 6003,
} as const;

/** OCSF API Activity activity ids. */
export const OCSF_API_ACTIVITY = {
  create: 1,
  read: 2,
  update: 3,
  delete: 4,
  other: 99,
} as const;

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;

const AttributeValueSchema = z.union([
  z.string().max(512),
  z.number(),
  z.boolean(),
  z.array(z.string().max(256)).max(256),
]);

export const AuditEventSchema = z.strictObject({
  specversion: z.literal('1.0'),
  /** Unique event id; sinks dedupe on it because queues deliver at least once. */
  id: z.uuid(),
  /** Producer and environment, for example `kilo:sts:production`. */
  source: z.string().regex(/^kilo:[a-z0-9-]+:(development|staging|production)$/),
  /** Reverse-DNS event type, for example `ai.kilo.sts.bundle.delivered`. */
  type: z.string().regex(/^ai\.kilo\.[a-z0-9_]+(\.[a-z0-9_]+)+$/),
  time: z.iso.datetime(),
  datacontenttype: z.literal('application/json'),
  data: z.strictObject({
    classUid: z.number().int().positive(),
    activityId: z.number().int().nonnegative(),
    outcome: z.enum(AUDIT_OUTCOMES),
    outcomeDetail: z.string().max(512).optional(),
    actor: z.strictObject({
      kind: z.enum(['workload', 'user', 'service', 'system']),
      id: z.string().min(1).max(256),
    }),
    /** Kilo extension fields: workload, versions, ETag, requesting service, and similar. */
    attributes: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), AttributeValueSchema),
  }),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AUDIT_BATCH_MAX_EVENTS = 500;
export const AUDIT_BATCH_MAX_COMPRESSED_BYTES = 60_000;

/**
 * One relay batch from one audit stream. A stream is one ordered producer log, for example one
 * Durable Object. Sequence numbers are contiguous per stream and start at 1.
 */
export const AuditBatchSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stream: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,190}$/),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    events: z.array(AuditEventSchema).min(1).max(AUDIT_BATCH_MAX_EVENTS),
  })
  .refine(batch => batch.toSeq - batch.fromSeq + 1 === batch.events.length, {
    message: 'toSeq - fromSeq + 1 must equal the event count',
  });
export type AuditBatch = z.infer<typeof AuditBatchSchema>;

export class AuditBatchTooLargeError extends Error {
  constructor(readonly compressedBytes: number) {
    super(`audit batch compresses to ${compressedBytes} bytes, above ${AUDIT_BATCH_MAX_COMPRESSED_BYTES}`);
    this.name = 'AuditBatchTooLargeError';
  }
}

async function pipeThrough(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream) {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
}

/** Gzips a validated batch for a queue message. Throws `AuditBatchTooLargeError`; the producer then splits the batch. */
export async function encodeAuditBatch(batch: AuditBatch): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(AuditBatchSchema.parse(batch)));
  const compressed = await pipeThrough(json, new CompressionStream('gzip'));
  if (compressed.byteLength > AUDIT_BATCH_MAX_COMPRESSED_BYTES) {
    throw new AuditBatchTooLargeError(compressed.byteLength);
  }
  return compressed;
}

/** Decodes and validates a queue message body produced by `encodeAuditBatch`. */
export async function decodeAuditBatch(body: ArrayBuffer | Uint8Array): Promise<AuditBatch> {
  const json = await pipeThrough(new Uint8Array(body), new DecompressionStream('gzip'));
  return AuditBatchSchema.parse(JSON.parse(new TextDecoder().decode(json)));
}
