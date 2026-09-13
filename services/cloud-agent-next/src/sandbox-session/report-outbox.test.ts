import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import {
  REPORT_ENQUEUE_MAX_ATTEMPTS,
  REPORT_ENQUEUE_RETRY_MS,
  REPORT_OUTBOX_MAX_ENTRIES,
  REPORT_OUTBOX_PREFIX,
  createReportOutbox,
  parsePendingRunReport,
  reportOutboxKey,
} from './report-outbox.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type MemoryKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options?: { prefix?: string }): Iterable<[string, T]>;
};

function memoryKv(): MemoryKv {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => values.set(key, structuredClone(value)),
    delete: key => values.delete(key),
    list: <T>(options?: { prefix?: string }) =>
      [...values.entries()]
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T] as [string, T]),
  };
}

function queuedReport(messageId: string): CloudAgentQueueReport {
  return {
    version: 1,
    type: 'run.state',
    occurredAt: '2026-05-26T08:00:00.000Z',
    session: { cloudAgentSessionId: 'agent_report_outbox' },
    run: {
      messageId,
      status: 'queued',
      queuedAt: '2026-05-26T08:00:00.000Z',
    },
  };
}

function failedReport(messageId: string): CloudAgentQueueReport {
  return {
    version: 1,
    type: 'run.state',
    occurredAt: '2026-05-26T08:04:00.000Z',
    session: { cloudAgentSessionId: 'agent_report_outbox' },
    run: {
      messageId,
      status: 'failed',
      terminalAt: '2026-05-26T08:04:00.000Z',
      failureStage: 'unknown',
      failureCode: 'unclassified',
    },
  };
}

function createHarness(
  options: {
    queue?: { send: (report: CloudAgentQueueReport) => Promise<unknown> };
  } = {}
) {
  const kv = memoryKv();
  const outbox = createReportOutbox({
    storage: { kv } as never,
    getQueue: () => options.queue as never,
  });
  return { kv, outbox };
}

describe('createReportOutbox', () => {
  it('keeps one latest cumulative snapshot per message under a fresh obligation identity', () => {
    const { kv, outbox } = createHarness();

    outbox.record(queuedReport('msg_one'));
    const first = parsePendingRunReport(kv.get(reportOutboxKey('msg_one')));
    outbox.record(queuedReport('msg_one'));
    const second = parsePendingRunReport(kv.get(reportOutboxKey('msg_one')));

    expect(second?.obligationId).toEqual(expect.any(String));
    expect(second?.obligationId).not.toBe(first?.obligationId);
    expect(outbox.pendingCount()).toBe(1);
  });

  it('evicts the entry with the greatest dueAt when the cap is reached', () => {
    const { kv, outbox } = createHarness();
    for (let index = 0; index < REPORT_OUTBOX_MAX_ENTRIES; index++) {
      outbox.record(queuedReport(`msg_${index}`));
    }
    const oldestKey = reportOutboxKey('msg_0');
    const stored = kv.get<Record<string, unknown>>(oldestKey);
    expect(stored).toBeDefined();
    kv.put(oldestKey, { ...stored, dueAt: Date.now() + 10_000_000 });

    outbox.record(queuedReport('msg_new'));

    expect(outbox.pendingCount()).toBe(REPORT_OUTBOX_MAX_ENTRIES);
    expect(kv.get(oldestKey)).toBeUndefined();
    expect(kv.get(reportOutboxKey('msg_new'))).toBeDefined();
  });

  it('keeps a newer obligation that replaced the one being sent', async () => {
    const { kv, outbox } = createHarness({
      queue: {
        send: async () => {
          outbox.record(queuedReport('msg_one'));
        },
      },
    });
    outbox.record(queuedReport('msg_one'));
    const sentObligationId = parsePendingRunReport(
      kv.get(reportOutboxKey('msg_one'))
    )?.obligationId;

    await outbox.repair();

    const stored = parsePendingRunReport(kv.get(reportOutboxKey('msg_one')));
    expect(stored?.obligationId).toEqual(expect.any(String));
    expect(stored?.obligationId).not.toBe(sentObligationId);
    expect(stored?.attempts).toBe(0);
  });

  it('deletes the obligation after a successful send', async () => {
    const sent: CloudAgentQueueReport[] = [];
    const { kv, outbox } = createHarness({
      queue: { send: async report => void sent.push(report) },
    });
    outbox.record(queuedReport('msg_one'));

    await outbox.repair();

    expect(sent).toHaveLength(1);
    expect(kv.get(reportOutboxKey('msg_one'))).toBeUndefined();
  });

  it('retries a failed send and abandons after the attempt budget', async () => {
    const send = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    const { kv, outbox } = createHarness({ queue: { send } });
    outbox.record(queuedReport('msg_one'));

    let now = Date.now();
    for (let attempt = 1; attempt <= REPORT_ENQUEUE_MAX_ATTEMPTS; attempt++) {
      await outbox.repair(now);
      if (attempt < REPORT_ENQUEUE_MAX_ATTEMPTS) {
        expect(parsePendingRunReport(kv.get(reportOutboxKey('msg_one')))?.attempts).toBe(attempt);
        now += REPORT_ENQUEUE_RETRY_MS;
      }
    }

    expect(send).toHaveBeenCalledTimes(REPORT_ENQUEUE_MAX_ATTEMPTS);
    expect(kv.get(reportOutboxKey('msg_one'))).toBeUndefined();
  });

  it('keeps a reserved obligation while no queue binding is available', async () => {
    const { kv, outbox } = createHarness();
    outbox.record(queuedReport('msg_one'));

    const now = Date.now();
    await outbox.repair(now);

    expect(parsePendingRunReport(kv.get(reportOutboxKey('msg_one')))?.attempts).toBe(1);
    expect(outbox.nextDueAt()).toBe(now + REPORT_ENQUEUE_RETRY_MS);
  });

  it('deletes invalid persisted entries instead of sending them', async () => {
    const sent: CloudAgentQueueReport[] = [];
    const { kv, outbox } = createHarness({
      queue: { send: async report => void sent.push(report) },
    });
    kv.put(`${REPORT_OUTBOX_PREFIX}msg_bad`, { attempts: 0, dueAt: Date.now() });
    kv.put(`${REPORT_OUTBOX_PREFIX}msg_older_shape`, { job: {}, attempts: 0, dueAt: Date.now() });

    expect(outbox.pendingCount()).toBe(2);
    await outbox.repair();

    expect(sent).toHaveLength(0);
    expect(outbox.pendingCount()).toBe(0);
  });

  it('keeps a newer snapshot that lands while an older entry send is in flight', async () => {
    const kv = memoryKv();
    const firstSend = Promise.withResolvers<void>();
    const secondSend = Promise.withResolvers<void>();
    const sent: string[] = [];
    const outbox = createReportOutbox({
      storage: { kv } as never,
      getQueue: () =>
        ({
          send: async (report: CloudAgentQueueReport) => {
            sent.push(report.run.messageId);
            return sent.length === 1 ? firstSend.promise : secondSend.promise;
          },
        }) as never,
    });
    outbox.record(queuedReport('msg_a'));
    outbox.record(queuedReport('msg_b'));

    const repair = outbox.repair(Date.now() + 1_000_000);
    // Replaces B with a newer terminal obligation while A's send is still pending.
    outbox.record(failedReport('msg_b'));
    const newer = parsePendingRunReport(kv.get(reportOutboxKey('msg_b')));
    firstSend.resolve();
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const stored = parsePendingRunReport(kv.get(reportOutboxKey('msg_b')));
    expect(stored?.obligationId).toBe(newer?.obligationId);
    expect(stored?.report.run.status).toBe('failed');

    secondSend.resolve();
    await repair;
  });

  it('does not delete a newer obligation when an exhausted send fails', async () => {
    const kv = memoryKv();
    const reject = Promise.withResolvers<void>();
    const outbox = createReportOutbox({
      storage: { kv } as never,
      getQueue: () => ({ send: async () => reject.promise }) as never,
    });
    const key = reportOutboxKey('msg_b');
    outbox.record(queuedReport('msg_b'));
    kv.put(key, {
      ...(parsePendingRunReport(kv.get(key)) as object),
      attempts: REPORT_ENQUEUE_MAX_ATTEMPTS - 1,
      dueAt: Date.now(),
    });

    const repair = outbox.repair(Date.now() + 1_000_000);
    // A newer obligation lands while the final attempt's send is pending.
    outbox.record(failedReport('msg_b'));
    const newer = parsePendingRunReport(kv.get(key));
    reject.reject(new Error('queue send failed'));
    await repair;

    const stored = parsePendingRunReport(kv.get(key));
    expect(stored?.obligationId).toBe(newer?.obligationId);
    expect(stored?.report.run.status).toBe('failed');
  });

  it('does not let an evicted in-flight send delete a recreated obligation', async () => {
    const kv = memoryKv();
    let sequence = 0;
    const firstSend = Promise.withResolvers<void>();
    const outbox = createReportOutbox({
      storage: { kv } as never,
      createObligationId: () => `ob_${++sequence}`,
      getQueue: () => ({ send: async () => firstSend.promise }) as never,
    });
    const key = reportOutboxKey('msg_a');
    outbox.record(queuedReport('msg_a'));

    // Repair reserves A (greatest dueAt) and holds its send open.
    const repair = outbox.repair(Date.now() + 1_000_000);
    for (let index = 0; index < REPORT_OUTBOX_MAX_ENTRIES - 1; index++) {
      outbox.record(queuedReport(`msg_filler_${index}`));
    }
    // The 51st entry forces enforceEntryCap to evict A while its send is in flight.
    outbox.record(queuedReport('msg_new'));
    expect(kv.get(key)).toBeUndefined();

    // A newer terminal snapshot re-creates A with a fresh obligation identity.
    outbox.record(failedReport('msg_a'));
    const recreated = parsePendingRunReport(kv.get(key));
    expect(recreated?.report.run.status).toBe('failed');

    firstSend.resolve();
    await repair;

    const stored = parsePendingRunReport(kv.get(key));
    expect(stored?.obligationId).toBe(recreated?.obligationId);
    expect(stored?.report.run.status).toBe('failed');
    expect(stored?.attempts).toBe(0);
  });
});
