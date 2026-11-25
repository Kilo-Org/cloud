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
/** A consumer stops inflating a message past this size, so a gzip bomb cannot exhaust its memory. */
export const AUDIT_BATCH_MAX_DECOMPRESSED_BYTES = 1024 * 1024;

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

/** The producer splits a batch that throws this: it is above the compressed or the decompressed limit. */
export class AuditBatchTooLargeError extends Error {
  constructor(
    readonly compressedBytes: number,
    readonly decompressedBytes: number
  ) {
    super(
      `audit batch is ${decompressedBytes} bytes (limit ${AUDIT_BATCH_MAX_DECOMPRESSED_BYTES}) and compresses to ${compressedBytes} bytes (limit ${AUDIT_BATCH_MAX_COMPRESSED_BYTES})`
    );
    this.name = 'AuditBatchTooLargeError';
  }
}

/** A queue message that inflates past `AUDIT_BATCH_MAX_DECOMPRESSED_BYTES`. */
export class AuditBatchDecompressionLimitError extends Error {
  constructor() {
    super(`audit batch inflates past ${AUDIT_BATCH_MAX_DECOMPRESSED_BYTES} bytes`);
    this.name = 'AuditBatchDecompressionLimitError';
  }
}

/**
 * Copies a view into an `ArrayBuffer`-backed one. The Workers lib types keep a view's
 * buffer parameter, and `ReadableStream` here needs the non-shared form.
 */
function arrayBufferView(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function transformed(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream
): ReadableStream<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return source.pipeThrough(transform);
}

/** Reads a stream to the end, or throws once it has produced more than `limit` bytes. */
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AuditBatchDecompressionLimitError();
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Gzips a validated batch for a queue message. Throws `AuditBatchTooLargeError` when the batch is
 * above either size limit; the producer then splits it. A batch this accepts always decodes.
 */
export async function encodeAuditBatch(batch: AuditBatch): Promise<Uint8Array> {
  const json = arrayBufferView(
    new TextEncoder().encode(JSON.stringify(AuditBatchSchema.parse(batch)))
  );
  const compressed = new Uint8Array(
    await new Response(transformed(json, new CompressionStream('gzip'))).arrayBuffer()
  );
  if (
    compressed.byteLength > AUDIT_BATCH_MAX_COMPRESSED_BYTES ||
    json.byteLength > AUDIT_BATCH_MAX_DECOMPRESSED_BYTES
  ) {
    throw new AuditBatchTooLargeError(compressed.byteLength, json.byteLength);
  }
  return compressed;
}

/**
 * Decodes and validates a queue message body produced by `encodeAuditBatch`. Throws
 * `AuditBatchDecompressionLimitError` without reading further once the body inflates past
 * `AUDIT_BATCH_MAX_DECOMPRESSED_BYTES`.
 */
export async function decodeAuditBatch(body: ArrayBuffer | Uint8Array): Promise<AuditBatch> {
  const bytes = arrayBufferView(body instanceof Uint8Array ? body : new Uint8Array(body));
  const json = await readAtMost(
    transformed(bytes, new DecompressionStream('gzip')),
    AUDIT_BATCH_MAX_DECOMPRESSED_BYTES
  );
  return AuditBatchSchema.parse(JSON.parse(new TextDecoder().decode(json)));
}
