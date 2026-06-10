import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecurityAgentCommand,
  markSecurityAgentCommandQueueAdmissionFailed,
  markSecurityAgentCommandRetriesExhausted,
  transitionSecurityAgentCommandWithCurrentState,
} from '@kilocode/db';
import type * as DbModule from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import worker, { collectScheduledSyncOwners, type SecuritySyncQueueMessage } from './index.js';
import { processSecurityFindingDismissal } from './dismiss.js';
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
vi.mock('./dismiss.js', () => ({ processSecurityFindingDismissal: vi.fn() }));
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
});

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
      .mockReturnValueOnce({} as never);
    vi.mocked(syncOwner).mockResolvedValue({ synced: 1, errors: 0, staleRepos: 0 } as never);

    await worker.scheduled(
      {} as ScheduledController,
      {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        SYNC_QUEUE: {
          sendBatch: async batch => {
            queuedBatches.push(batch);
          },
        },
      } as CloudflareEnv,
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    const queuedMessage = queuedBatches[0]?.[0]?.body;
    expect(queuedBatches).toHaveLength(1);
    expect(queuedMessage).toMatchObject({
      trigger: 'scheduled',
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });

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

    vi.mocked(getWorkerDb).mockReturnValue({} as never);
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
      })
    );
    expect(transitionSecurityAgentCommandWithCurrentState).toHaveBeenNthCalledWith(
      1,
      {},
      expect.objectContaining({ status: 'running' })
    );
    expect(transitionSecurityAgentCommandWithCurrentState).toHaveBeenNthCalledWith(
      2,
      {},
      expect.objectContaining({ status: 'succeeded', resultCode: 'SYNC_COMPLETED' })
    );
    expect(
      vi.mocked(transitionSecurityAgentCommandWithCurrentState).mock.invocationCallOrder[1]
    ).toBeLessThan(ack.mock.invocationCallOrder[0] ?? Infinity);
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

    vi.mocked(getWorkerDb).mockReturnValue({} as never);
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
          actor: {
            id: 'user-123',
            email: 'owner@example.com',
            name: 'Owner Example',
          },
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
      actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
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
          actor: {
            id: legacyUserId,
            email: 'owner@example.com',
            name: 'Owner Example',
          },
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
      actor: { id: legacyUserId, email: 'owner@example.com', name: 'Owner Example' },
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
      {},
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
              actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
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
