import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteRetainedSecurityAgentCommands,
  reconcileStaleSecurityAgentCommands,
} from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import { discoverDueOwners, reconcileStaleAnalysisQueueRows } from './db/queries.js';
import { discoverQueuedRemediationAttempts } from './remediation.js';
import { dispatchDueOwners } from './dispatcher.js';

const loggerMock = vi.hoisted(() => {
  const logger = {
    withTags: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
  logger.withTags.mockReturnValue(logger);
  return logger;
});

vi.mock('@kilocode/db', () => ({
  deleteRetainedSecurityAgentCommands: vi.fn(),
  reconcileStaleSecurityAgentCommands: vi.fn(),
}));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./db/queries.js', () => ({
  discoverDueOwners: vi.fn(),
  reconcileStaleAnalysisQueueRows: vi.fn(),
}));
vi.mock('./remediation.js', () => ({ discoverQueuedRemediationAttempts: vi.fn() }));
vi.mock('./logger.js', () => ({
  logger: loggerMock,
  sanitizedExceptionName: (error: unknown) =>
    error instanceof Error ? error.name : 'UnknownError',
}));

const ownerQueueSend = vi.fn();
const remediationQueueSend = vi.fn();

function env(): CloudflareEnv {
  return {
    ENVIRONMENT: 'test',
    CF_VERSION_METADATA: { id: 'version-123', tag: '', timestamp: '' },
    HYPERDRIVE: { connectionString: 'postgres://sensitive-connection' },
    OWNER_QUEUE: { sendBatch: ownerQueueSend },
    REMEDIATION_ATTEMPT_QUEUE: { sendBatch: remediationQueueSend },
  } as unknown as CloudflareEnv;
}

beforeEach(() => {
  vi.clearAllMocks();
  loggerMock.withTags.mockReturnValue(loggerMock);
  vi.mocked(getWorkerDb).mockReturnValue({} as never);
  vi.mocked(reconcileStaleAnalysisQueueRows).mockResolvedValue({
    requeuedPendingCount: 1,
    failedRunningCount: 2,
  });
  vi.mocked(reconcileStaleSecurityAgentCommands).mockResolvedValue({
    staleAccepted: [{ id: 'sensitive-command-id' }],
    staleRunning: [{ id: 'another-sensitive-command-id' }],
  } as never);
  vi.mocked(deleteRetainedSecurityAgentCommands).mockResolvedValue(3);
  vi.mocked(discoverDueOwners).mockResolvedValue([{ type: 'user', id: 'sensitive-owner-id' }]);
  vi.mocked(discoverQueuedRemediationAttempts).mockResolvedValue(['sensitive-attempt-id']);
  ownerQueueSend.mockResolvedValue(undefined);
  remediationQueueSend.mockResolvedValue(undefined);
});

describe('dispatchDueOwners telemetry', () => {
  it('emits structured success telemetry for every stage without sensitive identifiers', async () => {
    const result = await dispatchDueOwners(env(), 'dispatch-123');

    expect(result).toMatchObject({
      dispatchId: 'dispatch-123',
      discoveredOwners: 1,
      enqueuedMessages: 1,
      discoveredRemediationAttempts: 1,
      enqueuedRemediationMessages: 1,
    });
    const stageTags = loggerMock.withTags.mock.calls
      .map(([tags]) => tags)
      .filter(tags => tags.event_name === 'security_auto_analysis.dispatcher_stage_succeeded');
    expect(stageTags.map(tags => tags.dispatcher_stage)).toEqual([
      'stale_analysis_queue_reconciliation',
      'stale_command_reconciliation',
      'retained_command_deletion',
      'due_owner_discovery',
      'owner_queue_sends',
      'remediation_attempt_discovery',
      'remediation_queue_sends',
    ]);
    expect(stageTags[0]).toMatchObject({
      dispatch_id: result.dispatchId,
      worker_environment: 'test',
      worker_version: 'version-123',
      requeued_pending_count: 1,
      failed_running_count: 2,
    });
    const serializedStageLogs = JSON.stringify(
      loggerMock.withTags.mock.calls.filter(
        ([tags]) =>
          (tags as { event_name?: string }).event_name ===
          'security_auto_analysis.dispatcher_stage_succeeded'
      )
    );
    expect(serializedStageLogs).not.toContain('sensitive-owner-id');
    expect(serializedStageLogs).not.toContain('sensitive-command-id');
    expect(serializedStageLogs).not.toContain('sensitive-attempt-id');
    expect(serializedStageLogs).not.toContain('postgres://');
  });

  it('logs one command_stalled event per reconciled stale command', async () => {
    vi.mocked(reconcileStaleSecurityAgentCommands).mockResolvedValueOnce({
      staleAccepted: [
        {
          id: 'stale-accepted-id',
          command_type: 'sync',
          owned_by_organization_id: 'org-123',
          accepted_at: new Date(Date.now() - 5_000).toISOString(),
          result_code: 'COMMAND_STALLED',
          repo_full_name: 'acme/widgets',
        },
      ],
      staleRunning: [
        {
          id: 'stale-running-id',
          command_type: 'sync',
          owned_by_user_id: 'user-123',
          accepted_at: new Date(Date.now() - 9_000).toISOString(),
          started_at: new Date(Date.now() - 4_000).toISOString(),
          last_error_redacted: 'must-not-be-logged',
        },
      ],
    } as never);

    await dispatchDueOwners(env(), 'dispatch-123');

    const stallTags = loggerMock.withTags.mock.calls
      .map(([tags]) => tags as Record<string, unknown>)
      .filter(tags => tags.event_name === 'security_auto_analysis.command_stalled');
    expect(stallTags).toHaveLength(2);
    expect(stallTags[0]).toMatchObject({
      command_id: 'stale-accepted-id',
      command_type: 'sync',
      owner_type: 'org',
      owner_id: 'org-123',
      previous_status: 'accepted',
      result_code: 'COMMAND_STALLED',
      repo_full_name: 'acme/widgets',
    });
    expect(Number(stallTags[0]?.age_ms)).toBeGreaterThanOrEqual(4_000);
    expect(stallTags[1]).toMatchObject({
      command_id: 'stale-running-id',
      owner_type: 'user',
      owner_id: 'user-123',
      previous_status: 'running',
      result_code: null,
    });
    expect(Number(stallTags[1]?.age_ms)).toBeGreaterThanOrEqual(3_000);
    const serializedStallLogs = JSON.stringify(stallTags);
    expect(serializedStallLogs).not.toContain('must-not-be-logged');
    expect(serializedStallLogs).not.toContain('postgres://');
    expect(stallTags[1]?.age_ms).not.toBeNull();
  });

  it('logs command_stalled with a null age_ms when timestamps are absent', async () => {
    vi.mocked(reconcileStaleSecurityAgentCommands).mockResolvedValueOnce({
      staleAccepted: [{ id: 'no-timestamp-id', command_type: 'sync' }],
      staleRunning: [],
    } as never);

    await dispatchDueOwners(env(), 'dispatch-123');

    const stallTags = loggerMock.withTags.mock.calls
      .map(([tags]) => tags as Record<string, unknown>)
      .filter(tags => tags.event_name === 'security_auto_analysis.command_stalled');
    expect(stallTags).toHaveLength(1);
    expect(stallTags[0]).toMatchObject({
      command_id: 'no-timestamp-id',
      age_ms: null,
      started_at: null,
      accepted_at: null,
      result_code: null,
      repo_full_name: null,
    });
  });

  it.each([
    {
      stage: 'stale_analysis_queue_reconciliation',
      fail: () => vi.mocked(reconcileStaleAnalysisQueueRows).mockRejectedValueOnce(stageError()),
    },
    {
      stage: 'stale_command_reconciliation',
      fail: () =>
        vi.mocked(reconcileStaleSecurityAgentCommands).mockRejectedValueOnce(stageError()),
    },
    {
      stage: 'retained_command_deletion',
      fail: () =>
        vi.mocked(deleteRetainedSecurityAgentCommands).mockRejectedValueOnce(stageError()),
    },
    {
      stage: 'due_owner_discovery',
      fail: () => vi.mocked(discoverDueOwners).mockRejectedValueOnce(stageError()),
    },
    {
      stage: 'owner_queue_sends',
      fail: () => ownerQueueSend.mockRejectedValueOnce(stageError()),
    },
    {
      stage: 'remediation_attempt_discovery',
      fail: () => vi.mocked(discoverQueuedRemediationAttempts).mockRejectedValueOnce(stageError()),
    },
    {
      stage: 'remediation_queue_sends',
      fail: () => remediationQueueSend.mockRejectedValueOnce(stageError()),
    },
  ])('logs and rethrows failures from $stage', async ({ stage, fail }) => {
    const error = stageError();
    fail();

    await expect(dispatchDueOwners(env())).rejects.toThrow(error.message);

    const failureTags = loggerMock.withTags.mock.calls
      .map(([tags]) => tags)
      .find(tags => tags.event_name === 'security_auto_analysis.dispatcher_failed');
    expect(failureTags).toMatchObject({
      dispatcher_stage: stage,
      dispatch_id: expect.any(String),
      exception_name: 'SensitiveDatabaseError',
      error_message: 'Dispatcher stage failed',
      elapsed_ms: expect.any(Number),
      worker_environment: 'test',
      worker_version: 'version-123',
    });
    expect(loggerMock.error).toHaveBeenCalledWith('security_auto_analysis.dispatcher_failed');
    const serializedLogs = JSON.stringify([
      loggerMock.withTags.mock.calls,
      loggerMock.error.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('secret-token');
    expect(serializedLogs).not.toContain('SELECT');
    expect(serializedLogs).not.toContain('sensitive-owner-id');
  });
});

function stageError(): Error {
  const error = new Error('secret-token SELECT * FROM users WHERE owner_id=sensitive-owner-id');
  error.name = 'SensitiveDatabaseError';
  return error;
}
