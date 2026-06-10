import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';
import { createCloudAgentReportStore } from './report-store.js';

const cloudAgentSessionId = 'agent_12345678-1234-4234-8234-123456789abc';
const occurredAt = '2026-05-25T12:00:00.000Z';

function makeDb(
  selectResults: unknown[][] = [],
  updateResults: unknown[][] = [],
  insertResults: unknown[][] = [],
  deleteResults: unknown[][] = []
) {
  const inserts: Array<{
    table: unknown;
    values?: Record<string, unknown>;
    conflictValues?: Record<string, unknown>;
  }> = [];
  const updates: Array<{ table: unknown; values?: Record<string, unknown>; where?: SQL }> = [];
  const deletes: unknown[] = [];
  const operations: string[] = [];
  const execute = vi.fn(async () => operations.push('execute'));

  function insert(table: unknown) {
    const call: {
      table: unknown;
      values?: Record<string, unknown>;
      conflictValues?: Record<string, unknown>;
    } = { table };
    let returning = false;
    inserts.push(call);
    const chain = {
      values(values: Record<string, unknown>) {
        call.values = values;
        return chain;
      },
      onConflictDoNothing() {
        return chain;
      },
      onConflictDoUpdate(config: { set: Record<string, unknown> }) {
        call.conflictValues = config.set;
        return chain;
      },
      returning() {
        returning = true;
        return chain;
      },
      then(resolve: (value: unknown) => unknown) {
        return resolve(returning ? (insertResults.shift() ?? []) : undefined);
      },
    };
    return chain;
  }

  function update(table: unknown) {
    const call: { table: unknown; values?: Record<string, unknown>; where?: SQL } = { table };
    const result = updateResults.shift() ?? [];
    updates.push(call);
    const chain = {
      set(values: Record<string, unknown>) {
        call.values = values;
        return chain;
      },
      where(condition?: SQL) {
        call.where = condition;
        return chain;
      },
      returning() {
        return chain;
      },
      then(resolve: (value: unknown) => unknown) {
        return resolve(result);
      },
    };
    return chain;
  }

  function deleteFrom(table: unknown) {
    let returning = false;
    operations.push('delete');
    deletes.push(table);
    const chain = {
      where() {
        return chain;
      },
      returning() {
        returning = true;
        return chain;
      },
      then(resolve: (value: unknown) => unknown) {
        return resolve(returning ? (deleteResults.shift() ?? []) : undefined);
      },
    };
    return chain;
  }

  function select() {
    const result = selectResults.shift() ?? [];
    const chain = {
      from() {
        return chain;
      },
      where() {
        return chain;
      },
      limit() {
        return chain;
      },
      then(resolve: (value: unknown[]) => unknown) {
        return resolve(result);
      },
    };
    return chain;
  }

  const tx = { insert, update, delete: deleteFrom, select, execute };
  return {
    db: {
      insert,
      update,
      delete: deleteFrom,
      select,
      execute,
      transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) =>
        operation(tx)
      ),
    },
    execute,
    inserts,
    updates,
    deletes,
    operations,
  };
}

describe('cloud agent reporting store', () => {
  it('creates a natural-key session report before setup proceeds', async () => {
    const fake = makeDb();
    const store = createCloudAgentReportStore(fake.db as never);
    await store.createSessionReport({
      cloudAgentSessionId,
      kiloSessionId: 'ses_12345678901234567890123456',
      initialMessageId: 'msg_initial',
      occurredAt,
    });
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(fake.inserts.find(call => call.table === cloud_agent_sessions)?.values).toEqual({
      cloud_agent_session_id: cloudAgentSessionId,
      kilo_session_id: 'ses_12345678901234567890123456',
      initial_message_id: 'msg_initial',
      created_at: occurredAt,
    });
  });

  it('attaches a derived sandbox identity to an existing session anchor', async () => {
    const fake = makeDb([], [[{ cloudAgentSessionId }]]);
    const store = createCloudAgentReportStore(fake.db as never);
    const result = await store.recordSandboxIdentity({
      cloudAgentSessionId,
      sandboxId: 'ses-abc123',
    });
    expect(result).toEqual({ applied: true });
    expect(fake.updates.find(call => call.table === cloud_agent_sessions)?.values).toEqual({
      sandbox_id: 'ses-abc123',
    });
  });

  it('records a typed pre-run failure with temporary sanitized detail', async () => {
    const fake = makeDb([], [[{ cloudAgentSessionId }]]);
    const store = createCloudAgentReportStore(fake.db as never);
    const result = await store.recordSessionFailure({
      cloudAgentSessionId,
      occurredAt,
      failure: { stage: 'initial_admission', code: 'initial_queue_full' },
      diagnostic: {
        errorMessageRedacted: 'Initial queue is full',
        errorExpiresAt: '2026-06-01T12:00:00.000Z',
      },
    });
    expect(result).toEqual({ applied: true });
    expect(fake.updates.find(call => call.table === cloud_agent_sessions)?.values).toMatchObject({
      failure_at: occurredAt,
      failure_stage: 'initial_admission',
      failure_code: 'initial_queue_full',
      error_message_redacted: 'Initial queue is full',
    });
  });

  it('preserves the first typed pre-run failure fact on later reports', async () => {
    const fake = makeDb([], [[]]);
    const store = createCloudAgentReportStore(fake.db as never);
    const result = await store.recordSessionFailure({
      cloudAgentSessionId,
      occurredAt: '2026-05-25T12:01:00.000Z',
      failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
    });
    const predicate = fake.updates.find(call => call.table === cloud_agent_sessions)?.where;
    expect(result).toEqual({ applied: false });
    expect(predicate).toBeDefined();
    if (!predicate) {
      throw new Error('expected session failure update predicate');
    }
    const query = getWorkerDb('postgres://unused:unused@localhost:0/unused')
      .update(cloud_agent_sessions)
      .set({ failure_at: occurredAt })
      .where(predicate)
      .toSQL().sql;
    expect(query).toMatch(/"cloud_agent_sessions"\."failure_at"\s+is null/i);
  });

  it('does not manufacture a parent for an unrecognized run report', async () => {
    const fake = makeDb([[]]);
    const store = createCloudAgentReportStore(fake.db as never);
    const result = await store.saveReport(
      {
        version: 1,
        type: 'run.state',
        occurredAt,
        session: { cloudAgentSessionId },
        run: { messageId: 'msg_missing_parent', status: 'queued', queuedAt: occurredAt },
      },
      occurredAt
    );
    expect(result).toEqual({ outcome: 'missing_parent' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('persists run milestones, typed failure and sanitized detail by natural composite key', async () => {
    const fake = makeDb([[{ createdAt: occurredAt }], []]);
    const store = createCloudAgentReportStore(fake.db as never);
    const result = await store.saveReport(
      {
        version: 1,
        type: 'run.state',
        occurredAt,
        session: { cloudAgentSessionId },
        run: {
          messageId: 'msg_failed',
          status: 'failed',
          queuedAt: occurredAt,
          terminalAt: occurredAt,
          failureStage: 'pre_dispatch',
          failureCode: 'workspace_setup_failed',
          diagnostic: {
            errorMessageRedacted: 'Workspace setup failed',
            errorExpiresAt: '2026-06-01T12:00:00.000Z',
          },
        },
      },
      occurredAt
    );
    expect(result).toEqual({ outcome: 'applied' });
    expect(
      fake.inserts.find(call => call.table === cloud_agent_session_runs)?.values
    ).toMatchObject({
      cloud_agent_session_id: cloudAgentSessionId,
      message_id: 'msg_failed',
      failure_code: 'workspace_setup_failed',
      error_message_redacted: 'Workspace setup failed',
    });
  });

  it('keeps established terminal outcomes and earliest observed dispatch on replay', async () => {
    const fake = makeDb([
      [{ createdAt: occurredAt }],
      [
        {
          status: 'failed',
          wrapperRunId: 'wr_first',
          queuedAt: occurredAt,
          dispatchAcceptedAt: '2026-05-25T12:02:00.000Z',
          agentActivityObservedAt: null,
          terminalAt: '2026-05-25T12:04:00.000Z',
          failureStage: 'unknown',
          failureCode: 'unclassified',
        },
      ],
    ]);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(
      {
        version: 1,
        type: 'run.state',
        occurredAt: '2026-05-25T12:05:00.000Z',
        session: { cloudAgentSessionId },
        run: {
          messageId: 'msg_failed',
          status: 'accepted',
          wrapperRunId: 'wr_second',
          dispatchAcceptedAt: '2026-05-25T12:03:00.000Z',
        },
      },
      occurredAt
    );
    expect(
      fake.updates.find(call => call.table === cloud_agent_session_runs)?.values
    ).toMatchObject({
      status: 'failed',
      wrapper_run_id: 'wr_first',
      dispatch_accepted_at: '2026-05-25T12:02:00.000Z',
      terminal_at: '2026-05-25T12:04:00.000Z',
      failure_code: 'unclassified',
    });
  });

  it('clears expired sanitized detail and purges rows older than 90 days', async () => {
    const fake = makeDb();
    const store = createCloudAgentReportStore(fake.db as never);
    await store.removeExpiredData(occurredAt);
    expect(fake.updates.find(call => call.table === cloud_agent_sessions)?.values).toEqual({
      error_message_redacted: null,
      error_expires_at: null,
    });
    expect(fake.updates.find(call => call.table === cloud_agent_session_runs)?.values).toEqual({
      error_message_redacted: null,
      error_expires_at: null,
    });
    expect(fake.deletes).toContain(cloud_agent_sessions);
    expect(fake.db.transaction).not.toHaveBeenCalled();
  });
});
