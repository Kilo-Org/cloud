import {
  CloudAgentQueueReportSchema,
  type CloudAgentQueueReport,
} from '@kilocode/worker-utils/cloud-agent-queue-report';
import { logger } from '../logger.js';

export const REPORT_OUTBOX_PREFIX = 'report_outbox:';
export const REPORT_ANCHOR_KEY = 'report_anchor';
export const REPORT_ENQUEUE_MAX_ATTEMPTS = 5;
export const REPORT_ENQUEUE_RETRY_MS = 30_000;
export const REPORT_OUTBOX_MAX_ENTRIES = 50;

type ReportQueue = Pick<Queue<CloudAgentQueueReport>, 'send'>;
type ReportStorage = Pick<DurableObjectStorage, 'kv'>;

export type PendingRunReport = {
  report: CloudAgentQueueReport;
  obligationId: string;
  attempts: number;
  dueAt: number;
};

export type ReportAnchor = {
  version: 1;
  kiloSessionId: string;
  initialMessageId: string;
  createdAt: number;
};

export type ReportOutboxDependencies = {
  storage: ReportStorage;
  getQueue: () => ReportQueue | undefined;
  createObligationId?: () => string;
};

export type ReportOutbox = {
  record(report: CloudAgentQueueReport): void;
  pendingCount(): number;
  nextDueAt(): number | undefined;
  repair(now?: number): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePendingRunReport(value: unknown): PendingRunReport | undefined {
  if (!isRecord(value)) return undefined;
  const parsed = CloudAgentQueueReportSchema.safeParse(value.report);
  const obligationId = value.obligationId;
  const attempts = value.attempts;
  const dueAt = value.dueAt;
  if (
    !parsed.success ||
    typeof obligationId !== 'string' ||
    obligationId.length === 0 ||
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    typeof dueAt !== 'number' ||
    !Number.isFinite(dueAt) ||
    attempts < 0 ||
    attempts > REPORT_ENQUEUE_MAX_ATTEMPTS
  ) {
    return undefined;
  }
  return { report: parsed.data, obligationId, attempts, dueAt };
}

export function reportOutboxKey(messageId: string): string {
  return `${REPORT_OUTBOX_PREFIX}${messageId}`;
}

export function readReportAnchor(storage: ReportStorage): ReportAnchor | undefined {
  const raw = storage.kv.get<unknown>(REPORT_ANCHOR_KEY);
  if (!isRecord(raw)) return undefined;
  const { version, kiloSessionId, initialMessageId, createdAt } = raw;
  if (
    version !== 1 ||
    typeof kiloSessionId !== 'string' ||
    typeof initialMessageId !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt)
  ) {
    return undefined;
  }
  return { version: 1, kiloSessionId, initialMessageId, createdAt };
}

export function writeReportAnchor(
  storage: ReportStorage,
  anchor: Omit<ReportAnchor, 'version'>
): void {
  storage.kv.put<ReportAnchor>(REPORT_ANCHOR_KEY, { version: 1, ...anchor });
}

export function createReportOutbox(dependencies: ReportOutboxDependencies): ReportOutbox {
  const { storage, getQueue } = dependencies;
  const createObligationId = dependencies.createObligationId ?? (() => crypto.randomUUID());
  let repairInFlight: Promise<void> | undefined;

  function pendingEntries(): Array<[string, PendingRunReport | undefined]> {
    return Array.from(storage.kv.list<unknown>({ prefix: REPORT_OUTBOX_PREFIX })).map(
      ([key, value]) => [key, parsePendingRunReport(value)]
    );
  }

  function enforceEntryCap(targetKey: string): void {
    const entries = Array.from(storage.kv.list<unknown>({ prefix: REPORT_OUTBOX_PREFIX }));
    if (entries.length < REPORT_OUTBOX_MAX_ENTRIES) return;
    if (entries.some(([key]) => key === targetKey)) return;
    const evicted = entries
      .filter(([key]) => key !== targetKey)
      .map(([key, value]) => ({
        key,
        dueAt: parsePendingRunReport(value)?.dueAt ?? Number.MAX_SAFE_INTEGER,
      }))
      .reduce((greatest, entry) => (entry.dueAt > greatest.dueAt ? entry : greatest));
    logger.withFields({ key: evicted.key }).warn('Cloud Agent report outbox entry evicted');
    storage.kv.delete(evicted.key);
  }

  function record(report: CloudAgentQueueReport): void {
    const key = reportOutboxKey(report.run.messageId);
    enforceEntryCap(key);
    storage.kv.put<PendingRunReport>(key, {
      report: structuredClone(report),
      obligationId: createObligationId(),
      attempts: 0,
      dueAt: Date.now(),
    });
  }

  function pendingCount(): number {
    return pendingEntries().length;
  }

  function nextDueAt(): number | undefined {
    let next: number | undefined;
    for (const [, pending] of pendingEntries()) {
      if (!pending || pending.attempts >= REPORT_ENQUEUE_MAX_ATTEMPTS) {
        next = Math.min(next ?? Date.now(), Date.now());
        continue;
      }
      next = Math.min(next ?? pending.dueAt, pending.dueAt);
    }
    return next;
  }

  function logFailure(
    pending: PendingRunReport | undefined,
    attempts: number,
    abandoned: boolean
  ): void {
    logger
      .withFields({
        messageId: pending?.report.run.messageId,
        status: pending?.report.run.status,
        attempts,
      })
      .error(
        abandoned
          ? 'Cloud Agent report enqueue abandoned'
          : 'Cloud Agent report enqueue failed; retry scheduled'
      );
  }

  /**
   * Reserves the next attempt only when the stored obligation identity still
   * matches the one being processed, so a newer snapshot recorded meanwhile —
   * even one that re-created the key after eviction — is never overwritten.
   */
  function reserveIfUnchanged(
    key: string,
    parsed: PendingRunReport,
    attempts: number,
    now: number
  ): boolean {
    const current = parsePendingRunReport(storage.kv.get<unknown>(key));
    if (current?.obligationId !== parsed.obligationId) return false;
    storage.kv.put<PendingRunReport>(key, {
      ...parsed,
      attempts,
      dueAt: now + REPORT_ENQUEUE_RETRY_MS,
    });
    return true;
  }

  /**
   * Deletes only when the stored obligation identity still matches what was
   * processed. Passing `undefined` deletes only an entry that is still
   * invalid/absent.
   */
  function deleteIfUnchanged(key: string, expected: PendingRunReport | undefined): boolean {
    const current = parsePendingRunReport(storage.kv.get<unknown>(key));
    if (current === undefined) {
      if (expected !== undefined) return false;
      storage.kv.delete(key);
      return true;
    }
    if (expected !== undefined && current.obligationId === expected.obligationId) {
      storage.kv.delete(key);
      return true;
    }
    return false;
  }

  async function runRepair(now: number): Promise<void> {
    const keys = Array.from(
      storage.kv.list<unknown>({ prefix: REPORT_OUTBOX_PREFIX }),
      ([key]) => key
    );
    for (const key of keys) {
      // Re-read each iteration: a previous entry's `await send` can span a
      // `record` that replaces this key with a newer obligation.
      const parsed = parsePendingRunReport(storage.kv.get<unknown>(key));
      if (parsed === undefined) {
        if (deleteIfUnchanged(key, undefined)) {
          logger
            .withFields({ keyPrefix: REPORT_OUTBOX_PREFIX })
            .error('Invalid report outbox entry');
        }
        continue;
      }
      if (parsed.attempts >= REPORT_ENQUEUE_MAX_ATTEMPTS) {
        logFailure(parsed, parsed.attempts, true);
        deleteIfUnchanged(key, parsed);
        continue;
      }
      if (parsed.dueAt > now) continue;

      const attempts = parsed.attempts + 1;
      const abandoned = attempts >= REPORT_ENQUEUE_MAX_ATTEMPTS;
      if (!reserveIfUnchanged(key, parsed, attempts, now)) continue;

      const queue = getQueue();
      if (!queue) {
        logFailure(parsed, attempts, abandoned);
        if (abandoned) deleteIfUnchanged(key, parsed);
        continue;
      }

      try {
        await queue.send(parsed.report);
        deleteIfUnchanged(key, parsed);
      } catch {
        logFailure(parsed, attempts, abandoned);
        if (abandoned) deleteIfUnchanged(key, parsed);
      }
    }
  }

  function repair(now = Date.now()): Promise<void> {
    if (repairInFlight) return repairInFlight;
    const pending = runRepair(now).finally(() => {
      repairInFlight = undefined;
    });
    repairInFlight = pending;
    return pending;
  }

  return {
    record,
    pendingCount,
    nextDueAt,
    repair,
  };
}
