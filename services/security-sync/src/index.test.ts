import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecurityAgentCommand,
  markSecurityAgentCommandQueueAdmissionFailed,
  markSecurityAgentCommandRetriesExhausted,
  transitionSecurityAgentCommandWithCurrentState,
} from '@kilocode/db';
import type * as DbModule from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import {
  settleOperation,
  recordOperationAcceptance,
  recordOperationProgress,
} from '@kilocode/db/operation-ledger';
import worker, { collectScheduledSyncOwners, type SecuritySyncQueueMessage } from './index.js';
import { processSecurityFindingDismissal } from './dismiss.js';
import { runSecurityNotificationSweep } from './notifications/sweep.js';
import { syncOwner } from './sync.js';

vi.mock('@kilocode/db', async importOriginal => {
  const {
    isTerminalSecurityAgentCommandTransitionOutcome,
    requireSecurityAgentCommandTransitionOrTerminal,
  } = await importOriginal<typeof DbModule>();
  return {
    createSecurityAgentCommand: vi.fn(),
    isTerminalSecurityAgentCommandTransitionOutcome,
    markSecurityAgentCommandQueueAdmissionFailed: vi.fn(),
    markSecurityAgentCommandRetriesExhausted: vi.fn(),
    requireSecurityAgentCommandTransitionOrTerminal,
    transitionSecurityAgentCommandWithCurrentState: vi.fn(),
  };
});
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('@kilocode/db/operation-ledger', () => ({
  OPERATION_NON_TERMINAL_STATUSES: ['admitted', 'reconcile_pending'],
  recordOperationAcceptance: vi.fn(),
  recordOperationProgress: vi.fn(),
  settleOperation: vi.fn(),
}));
vi.mock('./dismiss.js', () => ({ processSecurityFindingDismissal: vi.fn() }));
vi.mock('./notifications/sweep.js', () => ({ runSecurityNotificationSweep: vi.fn() }));
vi.mock('./sync.js', () => ({ syncOwner: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorkerDb).mockReturnValue({} as never);
  vi.mocked(createSecurityAgentCommand).mockResolvedValue({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  } as never);
  vi.mocked(transitionSecurityAgentCommandWithCurrentState).mockResolvedValue({
    transitioned: true,
    command: {},
  } as never);
  vi.mocked(markSecurityAgentCommandRetriesExhausted).mockResolvedValue({
    transitioned: true,
    command: {},
  } as never);
  vi.mocked(runSecurityNotificationSweep).mockResolvedValue({} as never);
  vi.mocked(recordOperationAcceptance).mockResolvedValue({} as never);
  vi.mocked(recordOperationProgress).mockResolvedValue({} as never);
});

/**
 * Worker db mock whose ledger provider-ref lookup succeeds but finds no rows.
 * Terminal messages for keyless/scheduled work have no ledger row, so the
 * settle must skip and the message must still be acknowledged.
 */
function emptyLedgerWorkerDb(): never {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [] as { id: string }[],
        }),
      }),
    }),
  } as never;
}

describe('collectScheduledSyncOwners', () => {
  it('skips owners whose automatic sync policy is disabled', () => {
    const owners = collectScheduledSyncOwners([
      {
        owned_by_organization_id: 'org-enabled',
        owned_by_user_id: null,
        config: { auto_sync_enabled: true },
      },
      {
        owned_by_organization_id: 'org-disabled',
        owned_by_user_id: null,
        config: { auto_sync_enabled: false },
      },
      {
        owned_by_organization_id: null,
        owned_by_user_id: 'user-default-enabled',
        config: {},
      },
    ]);

    expect(owners).toEqual([
      {
        owner: { organizationId: 'org-enabled' },
        ownerKey: 'org:org-enabled',
      },
      {
        owner: { userId: 'user-default-enabled' },
        ownerKey: 'user:user-default-enabled',
      },
    ]);
  });
});

describe('scheduled sync dispatch', () => {
  it('enqueues enabled owners and processes the scheduled queue message', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    vi.mocked(getWorkerDb)
      .mockReturnValueOnce({
        select: () => ({
          from: () => ({
            where: async () => [
              {
                owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                owned_by_user_id: null,
                config: { auto_sync_enabled: true },
              },
              {
                owned_by_organization_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                owned_by_user_id: null,
                config: { auto_sync_enabled: false },
              },
            ],
          }),
        }),
      } as never)
      .mockReturnValueOnce(emptyLedgerWorkerDb());
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);

    await worker.scheduled(
      { cron: '0 */6 * * *', scheduledTime: 1_700_000_000_000 } as ScheduledController,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async batch => {
            queuedBatches.push(batch);
          },
        },
      } as CloudflareEnv
    );

    const queuedMessage = queuedBatches[0]?.[0]?.body;
    expect(queuedBatches).toHaveLength(1);
    expect(queuedMessage).toMatchObject({
      trigger: 'scheduled',
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    const terminalEvent = JSON.parse(
      info.mock.calls.find(
        ([message]) => typeof message === 'string' && message.includes('scheduled_job.completed')
      )?.[0] ?? '{}'
    );
    expect(terminalEvent).toMatchObject({
      schedule: '0 */6 * * *',
      scheduled_time: 1_700_000_000_000,
      event_name: 'scheduled_job.completed',
      job_name: 'security_sync.dispatch',
      outcome: 'succeeded',
      owner_count: 1,
      enqueued_message_count: 1,
    });
    info.mockRestore();

    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      { messages: [{ body: queuedMessage, ack, retry }] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
      } as CloudflareEnv
    );

    expect(syncOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'scheduled',
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      })
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('runs notification sweep on hourly notification cron without sync dispatch', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SYNC_QUEUE: { sendBatch: vi.fn() },
      ENVIRONMENT: 'development',
    } as unknown as CloudflareEnv;
    vi.mocked(runSecurityNotificationSweep).mockResolvedValue({
      recovered: 1,
      stagedRecovered: 2,
      cancelled: 3,
      materialized: 4,
      reactivated: 5,
      processed: 6,
      sent: 7,
      retried: 8,
      failed: 9,
      deferred: 10,
      dispatchCapReached: true,
      materializationCapReached: false,
    } as never);

    await worker.scheduled(
      { cron: '15 * * * *', scheduledTime: 1_700_000_000_000 } as ScheduledController,
      env
    );

    expect(runSecurityNotificationSweep).toHaveBeenCalledWith(env);
    expect(getWorkerDb).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        info.mock.calls.find(
          ([message]) => typeof message === 'string' && message.includes('scheduled_job.completed')
        )?.[0] ?? '{}'
      )
    ).toMatchObject({
      job_name: 'security_sync.notification_sweep',
      outcome: 'succeeded',
      environment: 'development',
      scheduled_time: 1_700_000_000_000,
      schedule: '15 * * * *',
      staged_recovered: 2,
      dispatch_cap_reached: true,
      materialization_cap_reached: false,
    });
    info.mockRestore();
  });

  it('emits a dispatch failure event before rethrowing', async () => {
    const error = new Error('database unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getWorkerDb).mockReturnValueOnce({
      select: () => ({
        from: () => ({
          where: async () => {
            throw error;
          },
        }),
      }),
    } as never);

    await expect(
      worker.scheduled(
        { cron: '0 */6 * * *', scheduledTime: 1_700_000_000_000 } as ScheduledController,
        { HYPERDRIVE: { connectionString: 'postgres://worker' } } as CloudflareEnv
      )
    ).rejects.toThrow(error);
    expect(
      JSON.parse(
        errorLog.mock.calls.find(
          ([message]) => typeof message === 'string' && message.includes('scheduled_job.completed')
        )?.[0] ?? '{}'
      )
    ).toMatchObject({
      job_name: 'security_sync.dispatch',
      outcome: 'failed',
      exception_name: 'Error',
    });
    errorLog.mockRestore();
  });

  it('emits a notification sweep failure event before rethrowing', async () => {
    const error = new Error('notification database unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(runSecurityNotificationSweep).mockRejectedValue(error);

    await expect(
      worker.scheduled(
        { cron: '15 * * * *', scheduledTime: 1_700_000_000_000 } as ScheduledController,
        { ENVIRONMENT: 'development' } as unknown as CloudflareEnv
      )
    ).rejects.toThrow(error);
    expect(
      JSON.parse(
        errorLog.mock.calls.find(
          ([message]) => typeof message === 'string' && message.includes('scheduled_job.completed')
        )?.[0] ?? '{}'
      )
    ).toMatchObject({
      job_name: 'security_sync.notification_sweep',
      outcome: 'failed',
      exception_name: 'Error',
    });
    errorLog.mockRestore();
  });

  it('does not emit a terminal event for an unknown cron expression', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await worker.scheduled(
      { cron: '30 * * * *', scheduledTime: 1_700_000_000_000 } as ScheduledController,
      {} as CloudflareEnv
    );

    expect(info).toHaveBeenCalledWith('Ignoring unknown Security Sync cron expression', {
      cron: '30 * * * *',
    });
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('scheduled_job.completed'));
    info.mockRestore();
  });
});

describe('manual sync dispatch', () => {
  it('compensates the accepted command when sync queue admission fails', async () => {
    await expect(
      worker.fetch(
        new Request('https://security-sync.test/internal/manual-sync', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-api-key': 'worker-secret',
          },
          body: JSON.stringify({
            schemaVersion: 1,
            owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            actor: { id: 'user-123' },
          }),
        }),
        {
          INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
          HYPERDRIVE: { connectionString: 'postgres://worker' },
          SYNC_QUEUE: {
            sendBatch: async () => {
              throw new Error('queue unavailable');
            },
          },
        } as unknown as CloudflareEnv
      )
    ).rejects.toThrow('queue unavailable');
    expect(markSecurityAgentCommandQueueAdmissionFailed).toHaveBeenCalledWith(
      {},
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'Queue admission failed'
    );
  });

  it('accepts an authenticated repository command and enqueues worker processing', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const response = await worker.fetch(
      new Request('https://security-sync.test/internal/manual-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'worker-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          actor: {
            id: 'user-123',
            email: 'owner@example.com',
            name: 'Owner Example',
          },
          repoFullName: 'kilo/repo',
        }),
      }),
      {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async batch => {
            queuedBatches.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true, accepted: true });
    expect(queuedBatches).toHaveLength(1);
    expect(queuedBatches[0]?.[0]?.body).toMatchObject({
      trigger: 'manual',
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: {
        id: 'user-123',
        email: 'owner@example.com',
        name: 'Owner Example',
      },
      repoFullName: 'kilo/repo',
    });

    const workerDb = emptyLedgerWorkerDb();
    vi.mocked(getWorkerDb).mockReturnValue(workerDb);
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      { messages: [{ body: queuedBatches[0]?.[0]?.body, ack, retry }] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
      } as CloudflareEnv
    );

    expect(syncOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
        repoFullName: 'kilo/repo',
        notificationMaterializationEnabled: false,
      })
    );
    expect(transitionSecurityAgentCommandWithCurrentState).toHaveBeenNthCalledWith(
      1,
      workerDb,
      expect.objectContaining({ status: 'running' })
    );
    expect(transitionSecurityAgentCommandWithCurrentState).toHaveBeenNthCalledWith(
      2,
      workerDb,
      expect.objectContaining({ status: 'succeeded', resultCode: 'SYNC_COMPLETED' })
    );
    expect(
      vi.mocked(transitionSecurityAgentCommandWithCurrentState).mock.invocationCallOrder[1]
    ).toBeLessThan(ack.mock.invocationCallOrder[0] ?? Infinity);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('enables sync-time notification staging only for exact true rollout flag', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(emptyLedgerWorkerDb());
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            body: {
              schemaVersion: 1,
              runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              messageId: 'scheduled-sync-message',
              trigger: 'scheduled',
              owner: { userId: 'user-123' },
              ownerKey: 'user:user-123',
              chunkIndex: 0,
              chunkCount: 1,
              dispatchedAt: '2026-06-11T10:00:00.000Z',
            },
            ack,
            retry,
          },
        ],
      } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
        SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED: 'true',
      } as CloudflareEnv
    );

    expect(syncOwner).toHaveBeenCalledWith(
      expect.objectContaining({ notificationMaterializationEnabled: true })
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('accepts legacy OAuth user IDs in manual sync commands', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const legacyUserId = 'oauth:google:1234567890';
    const response = await worker.fetch(
      new Request('https://security-sync.test/internal/manual-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'worker-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          owner: { userId: legacyUserId },
          actor: {
            id: legacyUserId,
            email: 'owner@example.com',
            name: 'Owner Example',
          },
        }),
      }),
      {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async batch => {
            queuedBatches.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    expect(queuedBatches[0]?.[0]?.body).toMatchObject({
      trigger: 'manual',
      owner: { userId: legacyUserId },
      ownerKey: `user:${legacyUserId}`,
      actor: {
        id: legacyUserId,
      },
    });

    vi.mocked(getWorkerDb).mockReturnValue(emptyLedgerWorkerDb());
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      { messages: [{ body: queuedBatches[0]?.[0]?.body, ack, retry }] } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
      } as CloudflareEnv
    );

    expect(syncOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { userId: legacyUserId },
      })
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('skips duplicate manual sync work after the command is already terminal', async () => {
    vi.mocked(transitionSecurityAgentCommandWithCurrentState).mockResolvedValueOnce({
      transitioned: false,
      command: { status: 'succeeded', result_code: 'SYNC_COMPLETED' },
    } as never);
    vi.mocked(getWorkerDb).mockReturnValue(emptyLedgerWorkerDb());
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            attempts: 2,
            body: {
              schemaVersion: 1,
              commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              messageId: 'manual-sync-message',
              trigger: 'manual',
              owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
              ownerKey: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              chunkIndex: 0,
              chunkCount: 1,
              dispatchedAt: '2026-05-18T08:30:00.000Z',
              actor: { id: 'user-123' },
            },
            ack,
            retry,
          },
        ],
      } as never,
      { HYPERDRIVE: { connectionString: 'postgres://worker' } } as CloudflareEnv
    );

    expect(syncOwner).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('rejects migrated sync traffic when Worker command routing is paused', async () => {
    const response = await worker.fetch(
      new Request('https://security-sync.test/internal/manual-sync', { method: 'POST' }),
      { MANUAL_SYNC_COMMAND_ROUTING_ENABLED: 'false' } as CloudflareEnv
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Manual sync Worker routing is disabled',
    });
  });
});

describe('manual dismissal dispatch', () => {
  it('accepts an authenticated dismissal command and enqueues actor-aware Worker processing', async () => {
    const queuedBatches: MessageSendRequest<unknown>[][] = [];
    const response = await worker.fetch(
      new Request('https://security-sync.test/internal/dismiss-finding', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'worker-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          actor: { id: 'user-123' },
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          installationId: 'installation-123',
          reason: 'not_used',
          comment: 'No production usage',
        }),
      }),
      {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async batch => {
            queuedBatches.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true, accepted: true });
    expect(queuedBatches[0]?.[0]?.body).toMatchObject({
      kind: 'dismiss',
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123' },
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      installationId: 'installation-123',
      reason: 'not_used',
      comment: 'No production usage',
    });
  });

  it('accepts legacy OAuth user IDs in dismissal commands', async () => {
    const queuedBatches: MessageSendRequest<unknown>[][] = [];
    const legacyUserId = 'oauth:google:1234567890';
    const response = await worker.fetch(
      new Request('https://security-sync.test/internal/dismiss-finding', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'worker-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          owner: { userId: legacyUserId },
          actor: { id: legacyUserId },
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          installationId: 'installation-123',
          reason: 'not_used',
          comment: 'No production usage',
        }),
      }),
      {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async batch => {
            queuedBatches.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    expect(queuedBatches[0]?.[0]?.body).toMatchObject({
      kind: 'dismiss',
      owner: { userId: legacyUserId },
      actor: { id: legacyUserId },
    });
  });

  it('rejects migrated dismissal traffic when Worker command routing is paused', async () => {
    const response = await worker.fetch(
      new Request('https://security-sync.test/internal/dismiss-finding', { method: 'POST' }),
      { DISMISS_FINDING_COMMAND_ROUTING_ENABLED: 'false' } as CloudflareEnv
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Finding dismissal Worker routing is disabled',
    });
  });

  it('persists dismissal terminal state before acknowledging', async () => {
    vi.mocked(processSecurityFindingDismissal).mockResolvedValue({
      dismissed: true,
      findingSource: 'dependabot',
      commandStatus: 'succeeded',
      resultCode: 'FINDING_DISMISSED',
    });
    const workerDb = emptyLedgerWorkerDb();
    vi.mocked(getWorkerDb).mockReturnValue(workerDb);
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            attempts: 1,
            body: {
              schemaVersion: 1,
              kind: 'dismiss',
              commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              messageId: 'dismiss-message-123',
              dispatchedAt: '2026-05-18T08:30:00.000Z',
              owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
              actor: { id: 'user-123' },
              findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              installationId: 'installation-123',
              reason: 'not_used',
            },
            ack,
            retry,
          },
        ],
      } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
      } as CloudflareEnv
    );

    expect(transitionSecurityAgentCommandWithCurrentState).toHaveBeenNthCalledWith(
      2,
      workerDb,
      expect.objectContaining({ status: 'succeeded', resultCode: 'FINDING_DISMISSED' })
    );
    expect(
      vi.mocked(transitionSecurityAgentCommandWithCurrentState).mock.invocationCallOrder[1]
    ).toBeLessThan(ack.mock.invocationCallOrder[0] ?? Infinity);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not perform dismissal work when the running transition is rejected', async () => {
    vi.mocked(transitionSecurityAgentCommandWithCurrentState).mockResolvedValueOnce({
      transitioned: false,
      command: null,
    });
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            attempts: 1,
            body: {
              schemaVersion: 1,
              kind: 'dismiss',
              commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              messageId: 'dismiss-message-123',
              dispatchedAt: '2026-05-18T08:30:00.000Z',
              owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
              actor: { id: 'user-123' },
              findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              installationId: 'installation-123',
              reason: 'not_used',
            },
            ack,
            retry,
          },
        ],
      } as never,
      { HYPERDRIVE: { connectionString: 'postgres://worker' } } as CloudflareEnv
    );

    expect(processSecurityFindingDismissal).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('records exhausted dismissal retries before retrying final delivery to the DLQ', async () => {
    vi.mocked(transitionSecurityAgentCommandWithCurrentState).mockResolvedValueOnce({
      transitioned: false,
      command: null,
    });
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            attempts: 4,
            body: {
              schemaVersion: 1,
              kind: 'dismiss',
              commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              messageId: 'dismiss-message-123',
              dispatchedAt: '2026-05-18T08:30:00.000Z',
              owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
              actor: { id: 'user-123' },
              findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              installationId: 'installation-123',
              reason: 'not_used',
            },
            ack,
            retry,
          },
        ],
      } as never,
      { HYPERDRIVE: { connectionString: 'postgres://worker' } } as CloudflareEnv
    );

    expect(markSecurityAgentCommandRetriesExhausted).toHaveBeenCalledWith(
      {},
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    );
    expect(
      vi.mocked(markSecurityAgentCommandRetriesExhausted).mock.invocationCallOrder[0]
    ).toBeLessThan(retry.mock.invocationCallOrder[0] ?? Infinity);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retries queued dismissal messages when Worker processing throws', async () => {
    vi.mocked(getWorkerDb).mockReturnValue({} as never);
    vi.mocked(processSecurityFindingDismissal).mockRejectedValue(new Error('retry dismissal'));
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            attempts: 1,
            body: {
              schemaVersion: 1,
              kind: 'dismiss',
              commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              messageId: 'dismiss-message-123',
              dispatchedAt: '2026-05-18T08:30:00.000Z',
              owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
              actor: { id: 'user-123' },
              findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              installationId: 'installation-123',
              reason: 'not_used',
              comment: 'No production usage',
            },
            ack,
            retry,
          },
        ],
      } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
      } as CloudflareEnv
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('same-key operation ledger dedupe (P1-A-08e)', () => {
  type LedgerState = {
    id: string;
    intent: string;
    provider_ref: string | null;
    canonical_result: Record<string, unknown> | null;
  };

  type LedgerStateRef = { current: LedgerState | null };

  /**
   * Worker db mock whose `transaction` serializes callbacks one after the
   * other, mirroring the `FOR UPDATE` row lock: a second concurrent same-key
   * request only runs after the first committed its acceptance. The fake
   * transaction serves the current ledger row to the lock select, and its
   * delete removes the row (the guarded queue-failure cleanup).
   */
  function keyedLedgerDb(state: LedgerStateRef) {
    let tail: Promise<void> = Promise.resolve();
    const fakeTx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: async () => {
                const row = state.current;
                return row ? [row] : [];
              },
            }),
          }),
        }),
      }),
      delete: () => ({
        where: () => {
          state.current = null;
        },
      }),
    } as never;
    return {
      transaction: (work: (tx: never) => Promise<unknown>) => {
        const run = tail.then(() => work(fakeTx));
        tail = run.then(
          () => undefined,
          () => undefined
        );
        return run;
      },
    } as never;
  }

  /** Acceptance mock that writes the recorded correlation onto the row. */
  function recordAcceptanceOnRow(state: LedgerStateRef) {
    vi.mocked(recordOperationAcceptance).mockImplementation(async (_db, input) => {
      state.current = {
        ...state.current!,
        provider_ref: input.providerRef,
        canonical_result: input.canonicalResult,
      };
      return {} as never;
    });
  }

  function manualSyncEnv(queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][]) {
    return {
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SYNC_QUEUE: {
        sendBatch: async (batch: MessageSendRequest<SecuritySyncQueueMessage>[]) => {
          queuedBatches.push(batch);
        },
      },
    } as CloudflareEnv;
  }

  function manualSyncRequest(operationKey: string) {
    return new Request('https://security-sync.test/internal/manual-sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': 'worker-secret',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        origin: 'dashboard_refresh',
        operationKey,
      }),
    });
  }

  function dismissalRequest(operationKey: string) {
    return new Request('https://security-sync.test/internal/dismiss-finding', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': 'worker-secret',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        actor: { id: 'user-123' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installationId: 'installation-123',
        reason: 'not_used',
        operationKey,
      }),
    });
  }

  it('reuses the original accepted command on a same-key manual sync retry without enqueueing a duplicate', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);

    const firstResponse = await worker.fetch(
      manualSyncRequest('retry-safe-key-123'),
      manualSyncEnv(queuedBatches)
    );
    expect(firstResponse.status).toBe(202);
    const firstBody = (await firstResponse.json()) as {
      commandId?: string;
      runId?: string;
      messageId?: string;
    };

    // The acceptance is recorded in the same transaction that created the
    // command, before the queue batch is sent.
    expect(queuedBatches).toHaveLength(1);
    expect(recordOperationAcceptance).toHaveBeenCalledTimes(1);
    expect(recordOperationAcceptance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-id',
        providerRef: firstBody.messageId,
        canonicalResult: expect.objectContaining({
          commandId: firstBody.commandId,
          runId: firstBody.runId,
          messageId: firstBody.messageId,
          queueAdmitted: false,
        }),
      })
    );

    // The committed acceptance becomes the durable source for same-key retries.
    const secondResponse = await worker.fetch(
      manualSyncRequest('retry-safe-key-123'),
      manualSyncEnv(queuedBatches)
    );
    expect(secondResponse.status).toBe(202);
    await expect(secondResponse.json()).resolves.toEqual(firstBody);

    expect(createSecurityAgentCommand).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(1);
  });

  it('serializes concurrent same-key manual sync requests into one command and one queue batch', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);

    const [firstResponse, secondResponse] = await Promise.all([
      worker.fetch(manualSyncRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches)),
      worker.fetch(manualSyncRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches)),
    ]);
    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);

    const firstBody = (await firstResponse.json()) as Record<string, unknown>;
    await expect(secondResponse.json()).resolves.toEqual(firstBody);

    expect(createSecurityAgentCommand).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(1);
  });

  it('creates a fresh command when a keyed request has no recorded acceptance', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));

    const response = await worker.fetch(
      manualSyncRequest('retry-safe-key-123'),
      manualSyncEnv(queuedBatches)
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true, accepted: true });
    expect(createSecurityAgentCommand).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(1);
  });

  it('reuses the original accepted command on a same-key dismissal retry without enqueueing a duplicate', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'dismiss_finding',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);

    const firstResponse = await worker.fetch(
      dismissalRequest('retry-safe-key-123'),
      manualSyncEnv(queuedBatches)
    );
    expect(firstResponse.status).toBe(202);
    const firstBody = (await firstResponse.json()) as {
      commandId?: string;
      runId?: string;
      messageId?: string;
    };
    expect(queuedBatches).toHaveLength(1);
    expect(recordOperationAcceptance).toHaveBeenCalledTimes(1);

    const secondResponse = await worker.fetch(
      dismissalRequest('retry-safe-key-123'),
      manualSyncEnv(queuedBatches)
    );
    expect(secondResponse.status).toBe(202);
    await expect(secondResponse.json()).resolves.toEqual(firstBody);

    expect(createSecurityAgentCommand).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(1);
  });

  it('serializes concurrent same-key dismissal requests into one command and one queue batch', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'dismiss_finding',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);

    const [firstResponse, secondResponse] = await Promise.all([
      worker.fetch(dismissalRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches)),
      worker.fetch(dismissalRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches)),
    ]);
    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);

    const firstBody = (await firstResponse.json()) as Record<string, unknown>;
    await expect(secondResponse.json()).resolves.toEqual(firstBody);

    expect(createSecurityAgentCommand).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(1);
  });

  it('records the ledger acceptance before the queue batch is sent', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const sendBatch = vi.fn(async (batch: MessageSendRequest<SecuritySyncQueueMessage>[]) => {
      queuedBatches.push(batch);
    });
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);

    const response = await worker.fetch(manualSyncRequest('retry-safe-key-123'), {
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SYNC_QUEUE: { sendBatch },
    } as unknown as CloudflareEnv);
    expect(response.status).toBe(202);

    const acceptanceCall = vi.mocked(recordOperationAcceptance).mock.invocationCallOrder[0];
    const sendCall = sendBatch.mock.invocationCallOrder[0];
    expect(acceptanceCall).toBeDefined();
    expect(sendCall).toBeDefined();
    expect(acceptanceCall!).toBeLessThan(sendCall!);
  });

  it('releases the keyed queue-send claim when the queue batch fails to send', async () => {
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);
    vi.mocked(recordOperationProgress).mockImplementation(async (_db, _rowId, partialResult) => {
      state.current = {
        ...state.current!,
        canonical_result: { ...state.current!.canonical_result, ...partialResult },
      };
      return {} as never;
    });

    await expect(
      worker.fetch(manualSyncRequest('retry-safe-key-123'), {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async () => {
            throw new Error('queue unavailable');
          },
        },
      } as unknown as CloudflareEnv)
    ).rejects.toThrow('queue unavailable');
    expect(recordOperationProgress).toHaveBeenCalled();

    // The keyed row remains for same-key queue recovery.
    expect(state.current?.canonical_result).toMatchObject({ queueAdmitted: false });
    const retryBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const retryResponse = await worker.fetch(
      manualSyncRequest('retry-safe-key-123'),
      manualSyncEnv(retryBatches)
    );
    expect(retryResponse.status).toBe(202);
    expect(createSecurityAgentCommand).toHaveBeenCalledTimes(1);
    expect(retryBatches).toHaveLength(1);
  });

  it('fails a keyed manual sync request when no ledger row matches the operation key', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = { current: null };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));

    await expect(
      worker.fetch(manualSyncRequest('missing-row-key'), manualSyncEnv(queuedBatches))
    ).rejects.toThrow('Security operation ledger row not found for operation key missing-row-key');

    // No command, no acceptance write, and no queue effect: the web admitted
    // no row, so the Worker must fail instead of accepting blindly.
    expect(createSecurityAgentCommand).not.toHaveBeenCalled();
    expect(recordOperationAcceptance).not.toHaveBeenCalled();
    expect(queuedBatches).toHaveLength(0);
  });

  it('fails a keyed dismissal request when no ledger row matches the operation key', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = { current: null };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));

    await expect(
      worker.fetch(dismissalRequest('missing-row-key'), manualSyncEnv(queuedBatches))
    ).rejects.toThrow('Security operation ledger row not found for operation key missing-row-key');

    expect(createSecurityAgentCommand).not.toHaveBeenCalled();
    expect(queuedBatches).toHaveLength(0);
  });

  it('rejects a keyed manual sync when the admitted row has a dismissal intent', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'dismiss_finding',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));

    await expect(
      worker.fetch(manualSyncRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches))
    ).rejects.toThrow('Security operation ledger intent mismatch');
    expect(createSecurityAgentCommand).not.toHaveBeenCalled();
    expect(recordOperationAcceptance).not.toHaveBeenCalled();
    expect(queuedBatches).toHaveLength(0);
  });

  it('rejects a keyed dismissal when the admitted row has a manual sync intent', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));

    await expect(
      worker.fetch(dismissalRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches))
    ).rejects.toThrow('Security operation ledger intent mismatch');
    expect(createSecurityAgentCommand).not.toHaveBeenCalled();
    expect(recordOperationAcceptance).not.toHaveBeenCalled();
    expect(queuedBatches).toHaveLength(0);
  });

  it('rolls back and does not enqueue when the ledger acceptance update returns null', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    vi.mocked(recordOperationAcceptance).mockResolvedValueOnce(null as never);

    await expect(
      worker.fetch(manualSyncRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches))
    ).rejects.toThrow(
      'Security operation ledger acceptance was not recorded for operation key retry-safe-key-123'
    );

    expect(recordOperationAcceptance).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(0);
  });

  it('rolls back and does not enqueue when the ledger acceptance update throws', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    vi.mocked(recordOperationAcceptance).mockRejectedValueOnce(
      new Error('acceptance write failed')
    );

    await expect(
      worker.fetch(manualSyncRequest('retry-safe-key-123'), manualSyncEnv(queuedBatches))
    ).rejects.toThrow('acceptance write failed');

    expect(recordOperationAcceptance).toHaveBeenCalledTimes(1);
    expect(queuedBatches).toHaveLength(0);
  });

  it('returns a distinct internal error when queue-failure compensation fails and leaves the acceptance', async () => {
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);
    vi.mocked(recordOperationProgress).mockRejectedValueOnce(new Error('claim release failed'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      worker.fetch(manualSyncRequest('retry-safe-key-123'), {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async () => {
            throw new Error('queue unavailable');
          },
        },
      } as unknown as CloudflareEnv)
    ).rejects.toThrow(
      'Security operation ledger queue claim could not be released after queue failure'
    );

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release security queue-send claim'),
      expect.anything()
    );
    errorLog.mockRestore();
    // The compensation transaction failed, so the false acceptance is still
    // present: the distinct internal error is reported, never a normal queue
    // failure that would claim the acceptance was safely cleared.
    expect(state.current).not.toBeNull();
    expect(state.current?.provider_ref).not.toBeNull();
  });

  /**
   * Progress mock that mirrors the SQL `->>'queueSendClaimId'` compare-and-set
   * in `recordOperationProgress`: a write that names a superseded claim is a
   * no-op returning null, and only the current claim holder can mutate the row.
   */
  function recordProgressGuardedOnClaim(state: LedgerStateRef) {
    vi.mocked(recordOperationProgress).mockImplementation(
      async (_db, _rowId, partialResult, options) => {
        const currentClaim = state.current?.canonical_result?.queueSendClaimId;
        if (
          options?.expectedQueueSendClaimId !== undefined &&
          options.expectedQueueSendClaimId !== currentClaim
        ) {
          return null as never;
        }
        state.current = {
          ...state.current!,
          canonical_result: { ...state.current!.canonical_result, ...partialResult },
        };
        return {} as never;
      }
    );
  }

  it('does not let a stale sender confirm a newer queue-send claim after its queue send succeeds', async () => {
    const queuedBatches: MessageSendRequest<SecuritySyncQueueMessage>[][] = [];
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);
    recordProgressGuardedOnClaim(state);
    let staleClaimId: string | undefined;

    const response = await worker.fetch(manualSyncRequest('retry-safe-key-123'), {
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SYNC_QUEUE: {
        sendBatch: async (batch: MessageSendRequest<SecuritySyncQueueMessage>[]) => {
          queuedBatches.push(batch);
          // The lease expired while this sender was sending; a newer sender
          // re-claimed the row and now owns the queue-send claim.
          staleClaimId = state.current?.canonical_result?.queueSendClaimId as string | undefined;
          state.current = {
            ...state.current!,
            canonical_result: {
              ...state.current!.canonical_result,
              queueAdmitted: false,
              queueSendClaimedUntil: new Date(Date.now() + 60_000).toISOString(),
              queueSendClaimId: 'newer-claim-b',
            },
          };
        },
      },
    } as unknown as CloudflareEnv);
    expect(response.status).toBe(202);
    expect(queuedBatches).toHaveLength(1);

    // The confirm named the superseded claim, so the row still carries the
    // newer claim and was never flipped to admitted.
    const progressCalls = vi.mocked(recordOperationProgress).mock.calls;
    const lastProgressCall = progressCalls[progressCalls.length - 1];
    expect(staleClaimId).toBeDefined();
    expect(lastProgressCall?.[3]).toEqual({ expectedQueueSendClaimId: staleClaimId });
    expect(state.current?.canonical_result).toMatchObject({
      queueAdmitted: false,
      queueSendClaimId: 'newer-claim-b',
    });
  });

  it('does not let a stale sender clear a newer queue-send claim after its queue send fails', async () => {
    const state: LedgerStateRef = {
      current: {
        id: 'ledger-row-id',
        intent: 'manual_sync',
        provider_ref: null,
        canonical_result: null,
      },
    };
    vi.mocked(getWorkerDb).mockReturnValue(keyedLedgerDb(state));
    recordAcceptanceOnRow(state);
    recordProgressGuardedOnClaim(state);
    let staleClaimId: string | undefined;

    await expect(
      worker.fetch(manualSyncRequest('retry-safe-key-123'), {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async () => {
            // The claim moved to a newer sender before this sender's failure
            // release ran, so the release must not clear the newer claim.
            staleClaimId = state.current?.canonical_result?.queueSendClaimId as string | undefined;
            state.current = {
              ...state.current!,
              canonical_result: {
                ...state.current!.canonical_result,
                queueAdmitted: false,
                queueSendClaimedUntil: new Date(Date.now() + 60_000).toISOString(),
                queueSendClaimId: 'newer-claim-b',
              },
            };
            throw new Error('queue unavailable');
          },
        },
      } as unknown as CloudflareEnv)
    ).rejects.toThrow('queue unavailable');

    // The release named the superseded claim, so the newer claim and its live
    // lease are preserved instead of being cleared for blind re-admission.
    const progressCalls = vi.mocked(recordOperationProgress).mock.calls;
    const lastProgressCall = progressCalls[progressCalls.length - 1];
    expect(staleClaimId).toBeDefined();
    expect(lastProgressCall?.[3]).toEqual({ expectedQueueSendClaimId: staleClaimId });
    expect(state.current?.canonical_result).toMatchObject({
      queueAdmitted: false,
      queueSendClaimId: 'newer-claim-b',
    });
    const newerLease = state.current?.canonical_result?.queueSendClaimedUntil as string | undefined;
    expect(newerLease).toBeDefined();
    expect(Date.parse(newerLease!)).toBeGreaterThan(Date.now());
  });
});

describe('security operation ledger provider_ref join', () => {
  const messageId = 'manual-sync-message-123';
  const actor = { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' };

  function ledgerLookupDb(rows: { id: string }[]) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    } as never;
  }

  function syncQueueMessage(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId,
      trigger: 'manual',
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      ownerKey: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      chunkIndex: 0,
      chunkCount: 1,
      dispatchedAt: '2026-06-11T10:00:00.000Z',
      actor,
      ...overrides,
    };
  }

  async function processSyncMessage(
    overrides: Record<string, unknown> = {},
    attempts = 1
  ): Promise<{ ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> {
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      {
        messages: [{ attempts, body: syncQueueMessage(overrides), ack, retry }],
      } as never,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        GIT_TOKEN_SERVICE: {},
      } as CloudflareEnv
    );
    return { ack, retry };
  }

  it('settles a succeeded manual sync row as completed via the provider reference', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(ledgerLookupDb([{ id: 'ledger-row-id' }]));
    vi.mocked(syncOwner).mockResolvedValue({ synced: 3, errors: 0, staleRepos: 0 } as never);

    await processSyncMessage();

    expect(settleOperation).toHaveBeenCalledTimes(1);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-id',
        status: 'completed',
        outcomeCode: 'SYNC_COMPLETED',
        canonicalResult: { repo_count: 3, error_count: 0 },
      })
    );
    const settleCall = vi.mocked(settleOperation).mock.calls[0]?.[1] as {
      outboxEvent?: {
        eventName: string;
        distinctId: string;
        properties: Record<string, unknown>;
      };
    };
    expect(settleCall?.outboxEvent).toMatchObject({
      eventName: 'security_command_settled',
      distinctId: 'owner@example.com',
      properties: {
        source: 'server',
        surface: 'security',
        phase: 'terminal',
        intent: 'manual_sync',
        outcome: 'completed',
        repo_count: 3,
        error_count: 0,
      },
    });
  });

  it('settles a failed manual sync row as failed with the partial-failure result code', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(ledgerLookupDb([{ id: 'ledger-row-id' }]));
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 2, staleRepos: 0 } as never);

    await processSyncMessage();

    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-id',
        status: 'failed',
        outcomeCode: 'SYNC_PARTIAL_FAILURE',
      })
    );
  });

  it('settles a no-op manual sync row as no_op with the disabled result code', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(ledgerLookupDb([{ id: 'ledger-row-id' }]));
    vi.mocked(syncOwner).mockResolvedValue({
      synced: 0,
      errors: 0,
      staleRepos: [],
      commandResultCode: 'CONFIG_DISABLED',
    } as never);

    await processSyncMessage();

    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-id',
        status: 'no_op',
        outcomeCode: 'CONFIG_DISABLED',
      })
    );
  });

  it('skips the settle when no ledger row matches the provider reference', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(ledgerLookupDb([]));
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { ack, retry } = await processSyncMessage();

    expect(settleOperation).not.toHaveBeenCalled();
    expect(
      info.mock.calls.find(
        ([message]) =>
          typeof message === 'string' && message.includes('row not found for provider ref')
      )?.[0]
    ).toBe('Security operation ledger row not found for provider ref; skipping settle');
    info.mockRestore();
    // The missing-row skip is preserved: the terminal message is still
    // acknowledged, never retried.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not acknowledge a terminal message when the ledger settle fails', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(ledgerLookupDb([{ id: 'ledger-row-id' }]));
    vi.mocked(syncOwner).mockResolvedValue({ synced: 3, errors: 0, staleRepos: 0 } as never);
    vi.mocked(settleOperation).mockRejectedValueOnce(new Error('settle failed'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { ack, retry } = await processSyncMessage();

    expect(settleOperation).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('Failed to settle security operation ledger row'),
      expect.objectContaining({ result_code: 'SYNC_COMPLETED' })
    );
    errorLog.mockRestore();
    // The terminal message must not be acknowledged after a settlement
    // failure; it is retried so the settle runs again on redelivery.
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a terminal message when the ledger lookup fails', async () => {
    vi.mocked(getWorkerDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error('ledger lookup failed');
            },
          }),
        }),
      }),
    } as never);
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { ack, retry } = await processSyncMessage();

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('Security operation ledger lookup failed'),
      expect.objectContaining({ provider_ref: messageId })
    );
    errorLog.mockRestore();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('settles the row failed with retry-exhaustion after final delivery failure', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(ledgerLookupDb([{ id: 'ledger-row-id' }]));
    vi.mocked(syncOwner).mockRejectedValue(new Error('sync processing failed'));
    vi.mocked(markSecurityAgentCommandRetriesExhausted).mockResolvedValueOnce({
      transitioned: false,
      command: { status: 'failed', result_code: 'QUEUE_RETRIES_EXHAUSTED' },
    } as never);

    const { ack, retry } = await processSyncMessage({}, 4);

    expect(markSecurityAgentCommandRetriesExhausted).toHaveBeenCalledWith(
      expect.anything(),
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    );
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rowId: 'ledger-row-id',
        status: 'failed',
        outcomeCode: 'QUEUE_RETRIES_EXHAUSTED',
      })
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
