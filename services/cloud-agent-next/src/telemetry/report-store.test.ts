import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';
import type { CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { createCloudAgentReportStore } from './report-store.js';

const cloudAgentSessionId = 'agent_12345678-1234-4234-8234-123456789abc';
const occurredAt = '2026-05-25T12:00:00.000Z';
const diagnostic = {
  errorMessageRedacted: 'The model provider is unavailable',
  errorExpiresAt: '2026-06-01T12:00:00.000Z',
};
const failedReport = {
  version: 1,
  type: 'run.state',
  occurredAt,
  session: { cloudAgentSessionId },
  run: {
    messageId: 'msg_failed',
    wrapperRunId: 'wr_first',
    status: 'failed',
    terminalAt: occurredAt,
    failureStage: 'agent_activity',
    failureCode: 'assistant_error',
    failureResponsibility: 'unknown',
    failureReason: 'provider_unavailable',
    diagnostic,
  },
} satisfies CloudAgentRunStateReport;
const storedFailedRun = {
  status: 'failed',
  wrapperRunId: 'wr_first',
  queuedAt: occurredAt,
  dispatchAcceptedAt: null,
  agentActivityObservedAt: null,
  terminalAt: occurredAt,
  failureStage: 'agent_activity',
  failureCode: 'assistant_error',
  failureResponsibility: 'unknown',
  failureReason: 'provider_unavailable',
  errorMessageRedacted: null,
  errorExpiresAt: null,
};

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
  const deleteConditions: SQL[] = [];
  const selects: Array<{ fields: Record<string, unknown>; table?: unknown; where?: SQL }> = [];
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
      where(condition: SQL) {
        deleteConditions.push(condition);
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

  function select(fields: Record<string, unknown>) {
    const call: { fields: Record<string, unknown>; table?: unknown; where?: SQL } = { fields };
    selects.push(call);
    const result = selectResults.shift() ?? [];
    const chain = {
      from(table: unknown) {
        call.table = table;
        return chain;
      },
      where(condition: SQL) {
        call.where = condition;
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
    deleteConditions,
    selects,
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

  it('accepts control-plane workspace_ session ids on the session report', async () => {
    const workspaceSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
    const fake = makeDb();
    const store = createCloudAgentReportStore(fake.db as never);
    await store.createSessionReport({
      cloudAgentSessionId: workspaceSessionId,
      kiloSessionId: 'ses_12345678901234567890123456',
      initialMessageId: 'msg_initial',
      occurredAt,
    });
    expect(fake.inserts.find(call => call.table === cloud_agent_sessions)?.values).toEqual({
      cloud_agent_session_id: workspaceSessionId,
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
      failure_responsibility: 'unknown',
      failure_reason: 'initial_admission_unknown',
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
          workspaceFailureSubtype: 'setup_command_failed',
          failureResponsibility: 'user',
          failureReason: 'setup_command',
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
      failure_responsibility: 'user',
      failure_reason: 'setup_command',
      error_message_redacted: 'Workspace setup failed',
    });
  });

  it('does not attach responsibility from a replay with conflicting terminal facts', async () => {
    const fake = makeDb([
      [{ createdAt: occurredAt }],
      [
        {
          status: 'failed',
          wrapperRunId: null,
          queuedAt: occurredAt,
          dispatchAcceptedAt: null,
          agentActivityObservedAt: null,
          terminalAt: occurredAt,
          failureStage: 'unknown',
          failureCode: 'unclassified',
          failureResponsibility: null,
          failureReason: null,
          errorMessageRedacted: null,
          errorExpiresAt: null,
        },
      ],
    ]);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(
      {
        version: 1,
        type: 'run.state',
        occurredAt,
        session: { cloudAgentSessionId },
        run: {
          messageId: 'msg_failed',
          status: 'failed',
          terminalAt: occurredAt,
          failureStage: 'agent_activity',
          failureCode: 'payment_required',
          failureResponsibility: 'user',
          failureReason: 'insufficient_credits',
        },
      },
      occurredAt
    );
    expect(
      fake.updates.find(call => call.table === cloud_agent_session_runs)?.values
    ).toMatchObject({
      failure_code: 'unclassified',
      failure_responsibility: null,
      failure_reason: null,
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
          failureResponsibility: 'unknown',
          failureReason: 'unclassified',
          errorMessageRedacted: diagnostic.errorMessageRedacted,
          errorExpiresAt: diagnostic.errorExpiresAt,
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
      error_message_redacted: diagnostic.errorMessageRedacted,
      error_expires_at: diagnostic.errorExpiresAt,
    });
  });

  it('stores diagnostics using only the matching session and message', async () => {
    const fake = makeDb([[{ createdAt: occurredAt }], []]);
    const store = createCloudAgentReportStore(fake.db as never);

    expect(await store.saveReport(failedReport, occurredAt)).toEqual({ outcome: 'applied' });
    expect(fake.inserts[0]?.values).toMatchObject({
      cloud_agent_session_id: cloudAgentSessionId,
      message_id: failedReport.run.messageId,
      status: 'failed',
      error_message_redacted: diagnostic.errorMessageRedacted,
      error_expires_at: diagnostic.errorExpiresAt,
    });
    const selection = fake.selects.find(call => call.table === cloud_agent_session_runs);
    expect(selection?.fields.errorMessageRedacted).toBe(
      cloud_agent_session_runs.error_message_redacted
    );
    expect(selection?.fields.errorExpiresAt).toBe(cloud_agent_session_runs.error_expires_at);
    if (!selection?.where) throw new Error('expected run selection predicate');
    const query = getWorkerDb('postgres://unused:unused@localhost:0/unused')
      .select()
      .from(cloud_agent_session_runs)
      .where(selection.where)
      .toSQL();
    expect(query.sql).toMatch(
      /"cloud_agent_session_runs"\."cloud_agent_session_id" = \$1 and "cloud_agent_session_runs"\."message_id" = \$2/
    );
    expect(query.params).toEqual([cloudAgentSessionId, failedReport.run.messageId]);
  });

  it.each([
    ['missing', undefined],
    ['empty message', { ...diagnostic, errorMessageRedacted: '' }],
    ['oversized message', { ...diagnostic, errorMessageRedacted: 'm'.repeat(4097) }],
    ['invalid expiry', { ...diagnostic, errorExpiresAt: 'invalid timestamp' }],
    ['expiry at terminal time', { ...diagnostic, errorExpiresAt: occurredAt }],
    ['expiry beyond 30 days', { ...diagnostic, errorExpiresAt: '2026-06-25T12:00:00.000Z' }],
  ])('does not store a %s diagnostic or lose the outcome', async (_name, invalidDiagnostic) => {
    const fake = makeDb([[{ createdAt: occurredAt }], []]);
    const store = createCloudAgentReportStore(fake.db as never);
    const report: CloudAgentRunStateReport = {
      ...failedReport,
      run: {
        ...failedReport.run,
        diagnostic: invalidDiagnostic as CloudAgentRunStateReport['run']['diagnostic'],
      },
    };

    expect(await store.saveReport(report, occurredAt)).toEqual({ outcome: 'applied' });
    expect(fake.inserts[0]?.values).toMatchObject({ status: 'failed' });
    expect(fake.inserts[0]?.values).not.toHaveProperty('error_message_redacted');
    expect(fake.inserts[0]?.values).not.toHaveProperty('error_expires_at');
  });

  it.each(['queued', 'accepted', 'completed', 'interrupted'] as const)(
    'never stores diagnostics on a %s run',
    async status => {
      const fake = makeDb([[{ createdAt: occurredAt }], []]);
      const store = createCloudAgentReportStore(fake.db as never);
      await store.saveReport(
        {
          ...failedReport,
          run: {
            messageId: failedReport.run.messageId,
            status,
            dispatchAcceptedAt: status === 'accepted' ? occurredAt : undefined,
            terminalAt: status === 'completed' || status === 'interrupted' ? occurredAt : undefined,
            diagnostic,
          },
        },
        occurredAt
      );

      expect(fake.inserts[0]?.values).toMatchObject({ status });
      expect(fake.inserts[0]?.values).not.toHaveProperty('error_message_redacted');
      expect(fake.inserts[0]?.values).not.toHaveProperty('error_expires_at');
    }
  );

  it.each([null, '2026-05-29 12:00:00+00'])(
    'fills missing metadata without losing established diagnostic content or extending expiry %s',
    async errorExpiresAt => {
      const fake = makeDb([
        [{ createdAt: occurredAt }],
        [
          {
            ...storedFailedRun,
            wrapperRunId: null,
            terminalAt: '2026-05-25 12:00:00+00',
            failureResponsibility: null,
            failureReason: null,
            errorMessageRedacted: errorExpiresAt ? 'Original diagnostic' : null,
            errorExpiresAt,
          },
        ],
      ]);
      const store = createCloudAgentReportStore(fake.db as never);
      await store.saveReport(failedReport, occurredAt);

      expect(fake.updates[0]?.values).toMatchObject({
        status: 'failed',
        wrapper_run_id: 'wr_first',
        terminal_at: '2026-05-25 12:00:00+00',
        failure_responsibility: failedReport.run.failureResponsibility,
        failure_reason: failedReport.run.failureReason,
        error_message_redacted: errorExpiresAt
          ? 'Original diagnostic'
          : diagnostic.errorMessageRedacted,
        error_expires_at: errorExpiresAt ?? diagnostic.errorExpiresAt,
      });
    }
  );

  it.each(['queued', 'accepted'] as const)(
    'adds diagnostics on the first terminal report after %s',
    async status => {
      const fake = makeDb([
        [{ createdAt: occurredAt }],
        [
          {
            ...storedFailedRun,
            status,
            terminalAt: null,
            failureStage: null,
            failureCode: null,
            failureResponsibility: null,
            failureReason: null,
          },
        ],
      ]);
      const store = createCloudAgentReportStore(fake.db as never);
      await store.saveReport(failedReport, occurredAt);
      expect(fake.updates[0]?.values).toMatchObject({
        status: 'failed',
        terminal_at: occurredAt,
        error_message_redacted: diagnostic.errorMessageRedacted,
        error_expires_at: diagnostic.errorExpiresAt,
      });
    }
  );

  it.each([
    { name: 'terminal status', existing: { status: 'completed' } },
    { name: 'failure code', existing: { failureCode: 'wrapper_no_output' } },
    { name: 'responsibility', existing: { failureResponsibility: 'platform' } },
    { name: 'reason', existing: { failureReason: 'assistant_unknown' } },
    { name: 'wrapper identity', existing: { wrapperRunId: 'wr_other' } },
    { name: 'earlier terminal timestamp', existing: { terminalAt: '2026-05-25T11:59:00.000Z' } },
    { name: 'later terminal timestamp', existing: { terminalAt: '2026-05-25T12:01:00.000Z' } },
    {
      name: 'unidentified terminal timestamp',
      existing: { wrapperRunId: null, terminalAt: '2026-05-25T11:59:00.000Z' },
    },
  ])('does not fill diagnostics from a replay with conflicting $name', async ({ existing }) => {
    const fake = makeDb([[{ createdAt: occurredAt }], [{ ...storedFailedRun, ...existing }]]);
    const store = createCloudAgentReportStore(fake.db as never);
    expect(await store.saveReport(failedReport, occurredAt)).toEqual({ outcome: 'applied' });
    expect(fake.updates[0]?.values).toMatchObject({
      error_message_redacted: null,
      error_expires_at: null,
    });
  });

  it('keeps the first terminal timestamp across two mismatched replays without admitting rejected diagnostics', async () => {
    const existing = {
      ...storedFailedRun,
      queuedAt: '2026-05-25T11:57:30.000Z',
      dispatchAcceptedAt: '2026-05-25T11:58:30.000Z',
      agentActivityObservedAt: '2026-05-25T11:59:30.000Z',
      terminalAt: '2026-05-25T12:01:00.000Z',
    };
    const report = {
      ...failedReport,
      run: {
        ...failedReport.run,
        queuedAt: '2026-05-25T11:57:00.000Z',
        dispatchAcceptedAt: '2026-05-25T11:58:00.000Z',
        agentActivityObservedAt: '2026-05-25T11:59:00.000Z',
      },
    };
    const selectResults: unknown[][] = [[{ createdAt: occurredAt }], [existing]];
    const fake = makeDb(selectResults);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(report, '2026-05-25T12:02:00.000Z');
    const firstUpdate = fake.updates[0]?.values;
    if (!firstUpdate) throw new Error('expected first replay update');
    selectResults.push(
      [{ createdAt: occurredAt }],
      [
        {
          ...existing,
          queuedAt: firstUpdate.queued_at,
          dispatchAcceptedAt: firstUpdate.dispatch_accepted_at,
          agentActivityObservedAt: firstUpdate.agent_activity_observed_at,
          terminalAt: firstUpdate.terminal_at,
          errorMessageRedacted: firstUpdate.error_message_redacted,
          errorExpiresAt: firstUpdate.error_expires_at,
        },
      ]
    );
    await store.saveReport(report, '2026-05-25T12:02:00.000Z');

    expect(fake.updates).toHaveLength(2);
    for (const update of fake.updates) {
      expect(update.values).toMatchObject({
        status: 'failed',
        queued_at: report.run.queuedAt,
        dispatch_accepted_at: report.run.dispatchAcceptedAt,
        agent_activity_observed_at: report.run.agentActivityObservedAt,
        terminal_at: existing.terminalAt,
        error_message_redacted: null,
        error_expires_at: null,
      });
    }
  });

  it.each(['failed', 'completed', 'interrupted'] as const)(
    'fills a null legacy terminal time only when the failed replay matches status %s',
    async status => {
      const fake = makeDb([
        [{ createdAt: occurredAt }],
        [{ ...storedFailedRun, status, terminalAt: null }],
      ]);
      const store = createCloudAgentReportStore(fake.db as never);
      await store.saveReport(failedReport, occurredAt);
      expect(fake.updates[0]?.values).toMatchObject({
        status,
        terminal_at: status === 'failed' ? occurredAt : null,
        error_message_redacted: status === 'failed' ? diagnostic.errorMessageRedacted : null,
        error_expires_at: status === 'failed' ? diagnostic.errorExpiresAt : null,
      });
    }
  );

  it('does not fill diagnostics for the same failure code at a different stage', async () => {
    const fake = makeDb([
      [{ createdAt: occurredAt }],
      [{ ...storedFailedRun, failureStage: 'pre_dispatch', failureCode: 'payment_required' }],
    ]);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(
      {
        ...failedReport,
        run: { ...failedReport.run, failureCode: 'payment_required' },
      },
      occurredAt
    );
    expect(fake.updates[0]?.values).toMatchObject({
      failure_stage: 'pre_dispatch',
      failure_code: 'payment_required',
      error_message_redacted: null,
      error_expires_at: null,
    });
  });

  it.each([
    undefined,
    { ...diagnostic, errorMessageRedacted: 'The agent failed' },
    { ...diagnostic, errorMessageRedacted: '' },
    { ...diagnostic, errorExpiresAt: 'invalid timestamp' },
    { ...diagnostic, errorExpiresAt: '2026-06-24T12:00:00.000Z' },
  ])(
    'preserves the first diagnostic on absent, conflicting, invalid, or later-expiry replays: %j',
    async incomingDiagnostic => {
      const fake = makeDb([
        [{ createdAt: occurredAt }],
        [
          {
            ...storedFailedRun,
            errorMessageRedacted: diagnostic.errorMessageRedacted,
            errorExpiresAt: diagnostic.errorExpiresAt,
          },
        ],
      ]);
      const store = createCloudAgentReportStore(fake.db as never);
      await store.saveReport(
        {
          ...failedReport,
          run: { ...failedReport.run, diagnostic: incomingDiagnostic },
        },
        occurredAt
      );
      expect(fake.updates[0]?.values).toMatchObject({
        error_message_redacted: diagnostic.errorMessageRedacted,
        error_expires_at: diagnostic.errorExpiresAt,
      });
    }
  );

  it('does not persist diagnostic text that has already expired', async () => {
    const fake = makeDb([[{ createdAt: occurredAt }], []]);
    const store = createCloudAgentReportStore(fake.db as never);
    expect(await store.saveReport(failedReport, diagnostic.errorExpiresAt)).toEqual({
      outcome: 'applied',
    });
    expect(fake.inserts[0]?.values).toMatchObject({ status: 'failed' });
    expect(fake.inserts[0]?.values).not.toHaveProperty('error_message_redacted');
    expect(fake.inserts[0]?.values).not.toHaveProperty('error_expires_at');
  });

  it('clears expired diagnostic text and expiry across repeated reports', async () => {
    const existing = {
      ...storedFailedRun,
      errorMessageRedacted: diagnostic.errorMessageRedacted,
      errorExpiresAt: diagnostic.errorExpiresAt,
    };
    const selectResults: unknown[][] = [[{ createdAt: occurredAt }], [existing]];
    const fake = makeDb(selectResults);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(failedReport, diagnostic.errorExpiresAt);
    const firstUpdate = fake.updates[0]?.values;
    if (!firstUpdate) throw new Error('expected first replay update');
    selectResults.push(
      [{ createdAt: occurredAt }],
      [
        {
          ...existing,
          errorMessageRedacted: firstUpdate.error_message_redacted,
          errorExpiresAt: firstUpdate.error_expires_at,
        },
      ]
    );
    await store.saveReport(failedReport, diagnostic.errorExpiresAt);

    expect(fake.updates).toHaveLength(2);
    for (const update of fake.updates) {
      expect(update.values).toMatchObject({
        status: 'failed',
        error_message_redacted: null,
        error_expires_at: null,
      });
    }
  });

  it('does not revive expired diagnostics after cleanup clears their expiry', async () => {
    const existing = {
      ...storedFailedRun,
      errorMessageRedacted: diagnostic.errorMessageRedacted,
      errorExpiresAt: '2026-06-01 12:00:00+00',
    };
    const selectResults: unknown[][] = [];
    const fake = makeDb(selectResults);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.removeExpiredData(diagnostic.errorExpiresAt);
    const cleanup = fake.updates.find(update => update.table === cloud_agent_session_runs)?.values;
    if (!cleanup) throw new Error('expected expired run cleanup');
    selectResults.push(
      [{ createdAt: occurredAt }],
      [
        {
          ...existing,
          errorMessageRedacted: cleanup.error_message_redacted,
          errorExpiresAt: cleanup.error_expires_at,
        },
      ]
    );
    await store.saveReport(failedReport, diagnostic.errorExpiresAt);

    expect(fake.updates.at(-1)?.values).toMatchObject({
      status: 'failed',
      error_message_redacted: null,
      error_expires_at: null,
    });
    expect(cleanup).toEqual({ error_message_redacted: null, error_expires_at: null });
  });

  it('stores a later turn diagnostic after an earlier turn diagnostic expires', async () => {
    const fake = makeDb([
      [{ createdAt: occurredAt }],
      [
        {
          ...storedFailedRun,
          errorMessageRedacted: diagnostic.errorMessageRedacted,
          errorExpiresAt: diagnostic.errorExpiresAt,
        },
      ],
      [{ createdAt: occurredAt }],
      [],
    ]);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(failedReport, diagnostic.errorExpiresAt);
    const nextReport = {
      ...failedReport,
      occurredAt: diagnostic.errorExpiresAt,
      run: {
        ...failedReport.run,
        messageId: 'msg_next_failed',
        terminalAt: diagnostic.errorExpiresAt,
        diagnostic: { ...diagnostic, errorExpiresAt: '2026-07-01T12:00:00.000Z' },
      },
    };
    await store.saveReport(nextReport, diagnostic.errorExpiresAt);

    expect(fake.updates[0]?.values).toMatchObject({
      error_message_redacted: null,
      error_expires_at: null,
    });
    expect(fake.inserts[0]?.values).toMatchObject({
      cloud_agent_session_id: cloudAgentSessionId,
      message_id: nextReport.run.messageId,
      status: 'failed',
      error_message_redacted: diagnostic.errorMessageRedacted,
      error_expires_at: nextReport.run.diagnostic.errorExpiresAt,
    });
  });

  it('does not revive cleaned diagnostic text after 30 days', async () => {
    const fake = makeDb([[{ createdAt: occurredAt }], [{ ...storedFailedRun }]]);
    const store = createCloudAgentReportStore(fake.db as never);
    await store.saveReport(failedReport, '2026-06-24T12:00:00.000Z');
    expect(fake.updates[0]?.values).toMatchObject({
      status: 'failed',
      error_message_redacted: null,
      error_expires_at: null,
    });
  });

  it.each([89, 90, 91])('keeps the parent retention boundary unchanged at %s days', async age => {
    const createdAt = new Date(Date.parse(occurredAt) - age * 24 * 60 * 60 * 1000).toISOString();
    const fake = makeDb([[{ createdAt }], []]);
    const store = createCloudAgentReportStore(fake.db as never);
    expect(await store.saveReport(failedReport, occurredAt)).toEqual({
      outcome: age < 90 ? 'applied' : 'expired',
    });
    expect(fake.inserts).toHaveLength(age < 90 ? 1 : 0);
  });

  it('clears expired diagnostic pairs and purges rows older than 90 days', async () => {
    const fake = makeDb();
    const store = createCloudAgentReportStore(fake.db as never);
    await store.removeExpiredData(occurredAt);
    expect(fake.updates.find(call => call.table === cloud_agent_sessions)?.values).toEqual({
      error_message_redacted: null,
      error_expires_at: null,
    });
    const runCleanup = fake.updates.find(call => call.table === cloud_agent_session_runs);
    expect(runCleanup?.values).toEqual({
      error_message_redacted: null,
      error_expires_at: null,
    });
    const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');
    const diagnosticQuery = db
      .update(cloud_agent_session_runs)
      .set({ error_message_redacted: null, error_expires_at: null })
      .where(runCleanup?.where)
      .toSQL();
    expect(diagnosticQuery.sql).toMatch(
      /"error_expires_at" is not null and "cloud_agent_session_runs"\."error_expires_at" <=/
    );
    expect(diagnosticQuery.params.at(-1)).toBe(occurredAt);
    const retentionQuery = db.delete(cloud_agent_sessions).where(fake.deleteConditions[0]).toSQL();
    expect(retentionQuery.sql).toMatch(/"cloud_agent_sessions"\."created_at" <=/);
    expect(retentionQuery.params).toEqual([
      new Date(Date.parse(occurredAt) - 90 * 24 * 60 * 60 * 1000).toISOString(),
    ]);
    expect(fake.deletes).toContain(cloud_agent_sessions);
    expect(fake.db.transaction).not.toHaveBeenCalled();
  });
});
