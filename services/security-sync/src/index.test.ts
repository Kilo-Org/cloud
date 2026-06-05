import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import worker, { collectScheduledSyncOwners, type SecuritySyncQueueMessage } from './index.js';
import { processSecurityFindingDismissal } from './dismiss.js';
import { syncOwner } from './sync.js';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./dismiss.js', () => ({ processSecurityFindingDismissal: vi.fn() }));
vi.mock('./sync.js', () => ({ syncOwner: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
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

  it('retries queued dismissal messages when Worker processing throws', async () => {
    vi.mocked(getWorkerDb).mockReturnValue({} as never);
    vi.mocked(processSecurityFindingDismissal).mockRejectedValue(new Error('retry dismissal'));
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        messages: [
          {
            body: {
              schemaVersion: 1,
              kind: 'dismiss',
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
