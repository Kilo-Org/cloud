import {
  AUDIT_BATCH_MAX_EVENTS,
  AuditBatchTooLargeError,
  type AuditBatch,
  type AuditEvent,
} from '@kilocode/sts-contracts';

export type AuditRow = { seq: number; event: AuditEvent };

export type AuditRelayStore = {
  /** Committed rows with a sequence above `afterSeq`, oldest first. */
  nextRows(afterSeq: number, limit: number): AuditRow[];
  watermark(): number;
  advanceWatermark(toSeq: number): void;
  prune(olderThanMs: number): void;
};

export type AuditRelayResult = {
  sent: number;
  skipped: number[];
  remaining: boolean;
};

export const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounds one alarm's work; a larger backlog is picked up by the next alarm. */
const MAX_BATCHES_PER_RUN = 20;

async function sendRows(
  stream: string,
  rows: AuditRow[],
  send: (batch: AuditBatch) => Promise<void>
): Promise<{ sent: number; skipped: number[] }> {
  try {
    await send({
      schemaVersion: 1,
      stream,
      fromSeq: rows[0].seq,
      toSeq: rows[rows.length - 1].seq,
      events: rows.map(row => row.event),
    });
    return { sent: rows.length, skipped: [] };
  } catch (error) {
    if (!(error instanceof AuditBatchTooLargeError)) throw error;
    if (rows.length === 1) {
      // A single event above the message limit cannot be split further. Skip it
      // rather than stall the stream, and report the sequence so the caller logs it.
      return { sent: 0, skipped: [rows[0].seq] };
    }
    const middle = Math.ceil(rows.length / 2);
    const first = await sendRows(stream, rows.slice(0, middle), send);
    const second = await sendRows(stream, rows.slice(middle), send);
    return { sent: first.sent + second.sent, skipped: [...first.skipped, ...second.skipped] };
  }
}

/**
 * Sends every committed row above the watermark, oldest first, in contiguous
 * batches of at most `AUDIT_BATCH_MAX_EVENTS`. The watermark advances only after a
 * batch reached the queue, so a failure leaves the rows for the next alarm.
 */
export async function relayAudit(input: {
  store: AuditRelayStore;
  stream: string;
  send: (batch: AuditBatch) => Promise<void>;
  now: number;
}): Promise<AuditRelayResult> {
  const { store, stream, send, now } = input;
  let sent = 0;
  const skipped: number[] = [];
  let remaining = false;
  store.prune(now - AUDIT_RETENTION_MS);

  let cursor = store.watermark();
  for (let run = 0; run < MAX_BATCHES_PER_RUN; run += 1) {
    const rows = store.nextRows(cursor, AUDIT_BATCH_MAX_EVENTS);
    if (rows.length === 0) {
      remaining = false;
      break;
    }
    const result = await sendRows(stream, rows, send);
    sent += result.sent;
    skipped.push(...result.skipped);
    const last = rows[rows.length - 1];
    store.advanceWatermark(last.seq);
    cursor = last.seq;
    remaining = rows.length === AUDIT_BATCH_MAX_EVENTS;
    if (!remaining) break;
  }

  return { sent, skipped, remaining };
}
