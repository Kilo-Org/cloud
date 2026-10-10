import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { eq } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
  kilocode_users,
} from '@kilocode/db/schema';
import { logger } from '../../src/logger.js';
import { AGENT_OPEN_METRIC, COLLECTION_METRIC } from '../../src/telemetry/outcome-aggregate.js';
import {
  assembleOpenStock,
  readOpenStock,
  runCloudAgentOpenStockCollection,
  type OpenStockCell,
  type OpenStockQueryRow,
} from '../../src/telemetry/open-stock.js';

const { getPgDbMock } = vi.hoisted(() => ({ getPgDbMock: vi.fn() }));

vi.mock('../../src/db/pg.js', () => ({ getPgDb: getPgDbMock }));

// Fixture timestamps sit above the real retained reporting population, so
// pre-existing rows are excluded by the reader's own retention predicate rather
// than by an empty table. Exact counts assume nothing else creates sessions in
// this reserved post-2095 range and that two runs of this suite do not share a
// database concurrently. These fixtures are cleaned up per test, but the
// terminal-exclusion fixture still carries a real 2026 terminal_at, so normal
// serialized execution with per-test cleanup is what keeps the sibling outcome
// suite unaffected.
const FIXTURE_RETENTION_CUTOFF = '2095-01-01T00:00:00.000Z';
const FIXTURE_CREATED_AT = '2096-02-01T00:00:00.000Z';
const OBSERVED_AT = '2096-02-01T00:10:00.000Z';

let connectionString: string;
let reader: WorkerDb;
let writer: ReturnType<typeof createDrizzleClient>;
let originUserId: string;
const trackedSessionIds: string[] = [];

function requirePostgresUrl(): string {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('Set POSTGRES_URL to a migrated test database');
  return url;
}

const uniqueSessionId = (plane: 'agent' | 'workspace') => `${plane}_${randomUUID()}`;
const uniqueMessageId = () => `msg_${randomUUID().replace(/-/g, '')}`;

async function insertOrigin(
  cloudAgentSessionId: string,
  kiloSessionId: string,
  createdOnPlatform: string
): Promise<void> {
  await writer.db.insert(cli_sessions_v2).values({
    session_id: kiloSessionId,
    kilo_user_id: originUserId,
    cloud_agent_session_id: cloudAgentSessionId,
    created_on_platform: createdOnPlatform,
  });
}

async function insertSession(
  sessionId: string,
  createdAt: string,
  createdOnPlatform?: string
): Promise<string> {
  trackedSessionIds.push(sessionId);
  const initialMessageId = uniqueMessageId();
  const kiloSessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  await writer.db.insert(cloud_agent_sessions).values({
    cloud_agent_session_id: sessionId,
    kilo_session_id: kiloSessionId,
    initial_message_id: initialMessageId,
    created_at: createdAt,
  });
  if (createdOnPlatform !== undefined) {
    await insertOrigin(sessionId, kiloSessionId, createdOnPlatform);
  }
  return initialMessageId;
}

async function insertRun(values: {
  cloudAgentSessionId: string;
  messageId?: string;
  status: 'queued' | 'accepted' | 'completed' | 'failed';
  queuedAt?: string | null;
  dispatchAcceptedAt?: string | null;
  terminalAt?: string | null;
}): Promise<void> {
  await writer.db.insert(cloud_agent_session_runs).values({
    cloud_agent_session_id: values.cloudAgentSessionId,
    message_id: values.messageId ?? uniqueMessageId(),
    status: values.status,
    queued_at: values.queuedAt ?? null,
    dispatch_accepted_at: values.dispatchAcceptedAt ?? null,
    terminal_at: values.terminalAt ?? null,
  });
}

async function readStock(cutoff = FIXTURE_RETENTION_CUTOFF): Promise<OpenStockQueryRow[]> {
  return readOpenStock(reader, { retentionCutoff: cutoff });
}

function stockRow(
  rows: OpenStockQueryRow[],
  generation: OpenStockQueryRow['generation'],
  status: OpenStockQueryRow['status'],
  origin: OpenStockQueryRow['origin'] = 'unknown'
): OpenStockQueryRow | undefined {
  return rows.find(
    row => row.generation === generation && row.status === status && row.origin === origin
  );
}

function cell(
  cells: OpenStockCell[],
  generation: OpenStockCell['generation'],
  productOrigin: OpenStockCell['productOrigin']
): OpenStockCell | undefined {
  return cells.find(
    entry => entry.generation === generation && entry.productOrigin === productOrigin
  );
}

function failAtSelect(
  db: WorkerDb,
  error: Error
): { db: WorkerDb; state: { selectCalls: number } } {
  const state = { selectCalls: 0 };
  const instrumented = new Proxy(db, {
    get(target, property) {
      if (property !== 'select') return Reflect.get(target, property, target);
      return () => {
        state.selectCalls += 1;
        throw error;
      };
    },
  }) as WorkerDb;
  return { db: instrumented, state };
}

beforeAll(async () => {
  connectionString = requirePostgresUrl();
  reader = getWorkerDb(connectionString);
  writer = createDrizzleClient({ connectionString, ssl: false });
  originUserId = `oauth/test-origin-${randomUUID()}`;
  await writer.db.insert(kilocode_users).values({
    id: originUserId,
    google_user_email: `origin-${randomUUID()}@example.test`,
    google_user_name: 'Origin fixture',
    google_user_image_url: '',
    stripe_customer_id: '',
    api_token_pepper: null,
  });
});

afterEach(async () => {
  const ids = trackedSessionIds.splice(0);
  if (ids.length === 0) return;
  for (const id of ids) {
    await writer.db
      .delete(cloud_agent_sessions)
      .where(eq(cloud_agent_sessions.cloud_agent_session_id, id));
  }
});

afterAll(async () => {
  await writer.db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, originUserId));
  await writer.db.delete(kilocode_users).where(eq(kilocode_users.id, originUserId));
  await writer.pool.end();
  const readerPool = (reader as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await readerPool?.end();
});

describe('cloud agent open stock against PostgreSQL', () => {
  it('counts a null-age queued row beside a timestamped one in the same session without inventing an age', async () => {
    const sessionId = uniqueSessionId('agent');
    await insertSession(sessionId, FIXTURE_CREATED_AT);
    const queuedAt = '2026-02-01T00:05:00.000Z';
    await insertRun({ cloudAgentSessionId: sessionId, status: 'queued', queuedAt });
    await insertRun({ cloudAgentSessionId: sessionId, status: 'queued', queuedAt: null });

    const rows = await readStock();
    const queued = stockRow(rows, 'legacy', 'queued');
    expect(queued?.turns).toBe(2);
    expect(queued?.oldestQueuedEpochMs).toBe(Date.parse(queuedAt));

    const cells = assembleOpenStock(rows, OBSERVED_AT);
    expect(cell(cells, 'legacy', 'unknown')?.oldestQueuedAgeMs).toBe(
      Date.parse(OBSERVED_AT) - Date.parse(queuedAt)
    );
  });

  it('keeps an all-null queued group and an all-null accepted group with null ages', async () => {
    const queuedSession = uniqueSessionId('agent');
    await insertSession(queuedSession, FIXTURE_CREATED_AT);
    await insertRun({ cloudAgentSessionId: queuedSession, status: 'queued', queuedAt: null });

    const acceptedSession = uniqueSessionId('agent');
    await insertSession(acceptedSession, FIXTURE_CREATED_AT);
    await insertRun({
      cloudAgentSessionId: acceptedSession,
      status: 'accepted',
      dispatchAcceptedAt: null,
    });

    const rows = await readStock();
    const queued = stockRow(rows, 'legacy', 'queued');
    expect(queued?.turns).toBe(1);
    expect(queued?.oldestQueuedEpochMs).toBeNull();

    const accepted = stockRow(rows, 'legacy', 'accepted');
    expect(accepted?.turns).toBe(1);
    expect(accepted?.oldestAcceptedEpochMs).toBeNull();

    const cells = assembleOpenStock(rows, OBSERVED_AT);
    expect(cell(cells, 'legacy', 'unknown')?.oldestQueuedAgeMs).toBeNull();
    expect(cell(cells, 'legacy', 'unknown')?.oldestAcceptedAgeMs).toBeNull();
  });

  it('excludes terminal statuses and non-terminal rows that carry a terminal_at', async () => {
    const sessionId = uniqueSessionId('agent');
    await insertSession(sessionId, FIXTURE_CREATED_AT);
    const terminalAt = '2026-02-01T00:05:00.000Z';
    await insertRun({ cloudAgentSessionId: sessionId, status: 'completed', terminalAt });
    await insertRun({ cloudAgentSessionId: sessionId, status: 'failed', terminalAt });
    await insertRun({
      cloudAgentSessionId: sessionId,
      status: 'queued',
      queuedAt: terminalAt,
      terminalAt,
    });
    await insertRun({
      cloudAgentSessionId: sessionId,
      status: 'accepted',
      dispatchAcceptedAt: terminalAt,
      terminalAt,
    });

    expect(await readStock()).toEqual([]);
  });

  it('splits generations by the workspace_ prefix', async () => {
    const sessionIds = [
      uniqueSessionId('workspace'),
      uniqueSessionId('agent'),
      'workspace',
      `Workspace_${randomUUID()}`,
    ];
    for (const sessionId of sessionIds) {
      await insertSession(sessionId, FIXTURE_CREATED_AT);
      await insertRun({
        cloudAgentSessionId: sessionId,
        status: 'queued',
        queuedAt: FIXTURE_CREATED_AT,
      });
    }

    const rows = await readStock();
    expect(stockRow(rows, 'legacy', 'queued')?.turns).toBe(3);
    expect(stockRow(rows, 'control', 'queued')?.turns).toBe(1);
  });

  it('keeps the queued and accepted ages separate with discriminating timestamps', async () => {
    const sessionId = uniqueSessionId('agent');
    await insertSession(sessionId, FIXTURE_CREATED_AT);
    const queuedAt = '2026-02-01T00:00:00.000Z';
    const acceptedQueuedAt = '2026-01-01T00:00:00.000Z';
    const dispatchAcceptedAt = '2026-02-01T00:05:00.000Z';
    await insertRun({ cloudAgentSessionId: sessionId, status: 'queued', queuedAt });
    await insertRun({
      cloudAgentSessionId: sessionId,
      status: 'accepted',
      queuedAt: acceptedQueuedAt,
      dispatchAcceptedAt,
    });

    const rows = await readStock();
    expect(stockRow(rows, 'legacy', 'queued')?.turns).toBe(1);
    expect(stockRow(rows, 'legacy', 'accepted')?.turns).toBe(1);
    expect(stockRow(rows, 'legacy', 'queued')?.oldestQueuedEpochMs).toBe(Date.parse(queuedAt));
    expect(stockRow(rows, 'legacy', 'accepted')?.oldestAcceptedEpochMs).toBe(
      Date.parse(dispatchAcceptedAt)
    );

    const cells = assembleOpenStock(rows, OBSERVED_AT);
    const legacy = cell(cells, 'legacy', 'unknown');
    expect(legacy?.queuedTurns).toBe(1);
    expect(legacy?.acceptedTurns).toBe(1);
    expect(legacy?.oldestQueuedAgeMs).not.toBe(legacy?.oldestAcceptedAgeMs);
  });

  it('counts two open turns in one session as two turns', async () => {
    const sessionId = uniqueSessionId('agent');
    await insertSession(sessionId, FIXTURE_CREATED_AT);
    await insertRun({
      cloudAgentSessionId: sessionId,
      status: 'queued',
      queuedAt: '2026-02-01T00:00:00.000Z',
    });
    await insertRun({
      cloudAgentSessionId: sessionId,
      status: 'queued',
      queuedAt: '2026-02-01T00:01:00.000Z',
    });

    const rows = await readStock();
    expect(stockRow(rows, 'legacy', 'queued')?.turns).toBe(2);
    expect(stockRow(rows, 'legacy', 'queued')?.oldestQueuedEpochMs).toBe(
      Date.parse('2026-02-01T00:00:00.000Z')
    );
  });

  it('retains only sessions created strictly after the cutoff', async () => {
    const cutoff = '2096-01-15T00:00:00.000Z';
    const atCutoff = uniqueSessionId('agent');
    const older = uniqueSessionId('agent');
    const newer = uniqueSessionId('agent');
    await insertSession(atCutoff, cutoff);
    await insertSession(older, new Date(Date.parse(cutoff) - 1000).toISOString());
    await insertSession(newer, new Date(Date.parse(cutoff) + 1000).toISOString());
    for (const sessionId of [atCutoff, older, newer]) {
      await insertRun({
        cloudAgentSessionId: sessionId,
        status: 'queued',
        queuedAt: FIXTURE_CREATED_AT,
      });
    }

    const rows = await readStock(cutoff);
    expect(stockRow(rows, 'legacy', 'queued')?.turns).toBe(1);
  });

  it('returns exact finite epoch milliseconds and numeric counts from the raw reader', async () => {
    const sessionId = uniqueSessionId('agent');
    await insertSession(sessionId, FIXTURE_CREATED_AT);
    const queuedAt = '2026-02-01T00:02:00.000Z';
    const dispatchAcceptedAt = '2026-02-01T00:07:00.000Z';
    await insertRun({ cloudAgentSessionId: sessionId, status: 'queued', queuedAt });
    await insertRun({
      cloudAgentSessionId: sessionId,
      status: 'accepted',
      dispatchAcceptedAt,
    });

    const controlSessionId = uniqueSessionId('workspace');
    await insertSession(controlSessionId, FIXTURE_CREATED_AT);
    await insertRun({
      cloudAgentSessionId: controlSessionId,
      status: 'accepted',
      dispatchAcceptedAt: null,
    });

    const rows = await readStock();
    const queued = stockRow(rows, 'legacy', 'queued');
    expect(typeof queued?.turns).toBe('number');
    expect(typeof queued?.oldestQueuedEpochMs).toBe('number');
    expect(Number.isFinite(queued?.oldestQueuedEpochMs)).toBe(true);
    expect(queued?.oldestQueuedEpochMs).toBe(Date.parse(queuedAt));

    const accepted = stockRow(rows, 'legacy', 'accepted');
    expect(typeof accepted?.oldestAcceptedEpochMs).toBe('number');
    expect(Number.isFinite(accepted?.oldestAcceptedEpochMs)).toBe(true);
    expect(accepted?.oldestAcceptedEpochMs).toBe(Date.parse(dispatchAcceptedAt));

    const controlAccepted = stockRow(rows, 'control', 'accepted');
    expect(controlAccepted?.turns).toBe(1);
    expect(controlAccepted?.oldestAcceptedEpochMs).toBeNull();
  });

  it('keeps three created_on_platform origins as three cells inside the six rows', async () => {
    const reviewSession = uniqueSessionId('agent');
    const otherSession = uniqueSessionId('agent');
    const unknownSession = uniqueSessionId('agent');
    await insertSession(reviewSession, FIXTURE_CREATED_AT, 'code-review');
    await insertSession(otherSession, FIXTURE_CREATED_AT, 'cloud-agent-web');
    await insertSession(unknownSession, FIXTURE_CREATED_AT);
    await insertRun({
      cloudAgentSessionId: reviewSession,
      status: 'queued',
      queuedAt: '2026-02-01T00:00:00.000Z',
    });
    await insertRun({
      cloudAgentSessionId: otherSession,
      status: 'queued',
      queuedAt: '2026-02-01T00:01:00.000Z',
    });
    await insertRun({
      cloudAgentSessionId: unknownSession,
      status: 'queued',
      queuedAt: '2026-02-01T00:02:00.000Z',
    });

    const rows = await readStock();
    expect(stockRow(rows, 'legacy', 'queued', 'code-review')?.turns).toBe(1);
    expect(stockRow(rows, 'legacy', 'queued', 'other')?.turns).toBe(1);
    expect(stockRow(rows, 'legacy', 'queued', 'unknown')?.turns).toBe(1);

    const cells = assembleOpenStock(rows, OBSERVED_AT);
    expect(cells).toHaveLength(6);
    expect(cell(cells, 'legacy', 'code-review')?.queuedTurns).toBe(1);
    expect(cell(cells, 'legacy', 'other')?.queuedTurns).toBe(1);
    expect(cell(cells, 'legacy', 'unknown')?.queuedTurns).toBe(1);
    expect(cell(cells, 'legacy', 'code-review')?.oldestQueuedAgeMs).toBe(
      Date.parse(OBSERVED_AT) - Date.parse('2026-02-01T00:00:00.000Z')
    );
  });

  it('emits one collection row instead of zeros when the query is injected to fail', async () => {
    const injected = new Error('injected open-stock select failure');
    const instrumented = failAtSelect(reader, injected);

    const errorMock = vi.fn();
    const infoMock = vi.fn();
    const withFieldsSpy = vi
      .spyOn(logger, 'withFields')
      .mockReturnValue({ info: infoMock, error: errorMock } as never);
    getPgDbMock.mockReturnValue(instrumented.db);

    let records: Record<string, unknown>[] = [];
    try {
      await runCloudAgentOpenStockCollection({} as never, new Date(OBSERVED_AT));
      records = withFieldsSpy.mock.calls.map(([fields]) => fields as Record<string, unknown>);
    } finally {
      getPgDbMock.mockReset();
      withFieldsSpy.mockRestore();
    }

    expect(instrumented.state.selectCalls).toBe(1);
    expect(records).toEqual([
      {
        metric: COLLECTION_METRIC,
        collector: AGENT_OPEN_METRIC,
        observedAt: OBSERVED_AT,
        status: 'failed',
      },
    ]);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(infoMock).not.toHaveBeenCalled();
  });
});
