import {
  AUDIT_BATCH_MAX_EVENTS,
  AuditBatchTooLargeError,
  AuditEventSchema,
  encodeAuditBatch,
  type AuditBatch,
  type AuditEvent,
} from '@kilocode/sts-contracts';

export type AuditRow = { seq: number; event: AuditEvent };

export type AuditRelayStore = {
  /** Committed rows with a sequence above `afterSeq`, oldest first. */
  nextRows(afterSeq: number, limit: number): AuditRow[];
  watermark(): number;
  advanceWatermark(toSeq: number): void;
};

/** An event that cannot travel in a queue message even alone. Appends refuse it. */
export class AuditEventTooLargeError extends Error {
  constructor() {
    super('audit event does not fit one queue message on its own');
    this.name = 'AuditEventTooLargeError';
  }
}

/**
 * An event the batch schema refuses, such as one with a nested attribute. The relay's encode
 * would throw on it and stall the stream behind it, so appends refuse it first.
 */
export class AuditEventInvalidError extends Error {
  constructor() {
    super('audit event does not match the audit event schema');
    this.name = 'AuditEventInvalidError';
  }
}

/** Bounds one alarm's work; a larger backlog is picked up by the next alarm. */
const MAX_BATCHES_PER_RUN = 20;

/**
 * Below this many UTF-8 bytes of event JSON, a one-event batch is certain to fit: the batch
 * envelope adds well under 1 KB and gzip adds well under 1 KB to incompressible input, against a
 * 60,000-byte compressed and a 1 MiB uncompressed limit.
 */
const ALWAYS_FITS_BYTES = 50_000;

/**
 * Throws `AuditEventInvalidError` when the batch schema would refuse `event`, and
 * `AuditEventTooLargeError` when it could not be relayed even as a batch of one. Called before
 * every append, so the relay never meets an event it would have to skip.
 */
export async function assertRelayable(stream: string, event: AuditEvent): Promise<void> {
  if (!AuditEventSchema.safeParse(event).success) throw new AuditEventInvalidError();
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength < ALWAYS_FITS_BYTES) return;
  try {
    await encodeAuditBatch({
      schemaVersion: 1,
      stream,
      fromSeq: Number.MAX_SAFE_INTEGER,
      toSeq: Number.MAX_SAFE_INTEGER,
      events: [event],
    });
  } catch (error) {
    if (error instanceof AuditBatchTooLargeError) throw new AuditEventTooLargeError();
    throw error;
  }
}

async function sendRows(
  store: AuditRelayStore,
  stream: string,
  rows: AuditRow[],
  send: (batch: AuditBatch) => Promise<void>
): Promise<void> {
  const toSeq = rows[rows.length - 1].seq;
  try {
    await send({
      schemaVersion: 1,
      stream,
      fromSeq: rows[0].seq,
      toSeq,
      events: rows.map(row => row.event),
    });
    store.advanceWatermark(toSeq);
  } catch (error) {
    if (!(error instanceof AuditBatchTooLargeError)) throw error;
    // Appends refuse an event that does not fit alone, so a single row here is a broken
    // invariant: stop with the watermark where it is rather than leave a gap in the stream.
    if (rows.length === 1) throw new AuditEventTooLargeError();
    const middle = Math.ceil(rows.length / 2);
    await sendRows(store, stream, rows.slice(0, middle), send);
    await sendRows(store, stream, rows.slice(middle), send);
  }
}

/**
 * Sends every committed row above the watermark, oldest first, in contiguous batches of at most
 * `AUDIT_BATCH_MAX_EVENTS`, splitting a batch the encoder refuses. The watermark advances after
 * each batch the queue accepted, so a failure leaves only unsent rows for the next alarm. Returns
 * the number of events sent.
 */
export async function relayAudit(input: {
  store: AuditRelayStore;
  stream: string;
  send: (batch: AuditBatch) => Promise<void>;
}): Promise<number> {
  const { store, stream, send } = input;
  let sent = 0;
  let cursor = store.watermark();
  for (let run = 0; run < MAX_BATCHES_PER_RUN; run += 1) {
    const rows = store.nextRows(cursor, AUDIT_BATCH_MAX_EVENTS);
    if (rows.length === 0) break;
    await sendRows(store, stream, rows, send);
    sent += rows.length;
    cursor = rows[rows.length - 1].seq;
    if (rows.length < AUDIT_BATCH_MAX_EVENTS) break;
  }
  return sent;
}
