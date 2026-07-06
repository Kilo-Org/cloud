import type { DirectoryBackup } from '@cloudflare/sandbox';
import { describe, expect, it, vi } from 'vitest';

import {
  buildWorkspaceBackupCandidate,
  createWorkspaceBackupRecord,
  loadWorkspaceBackupRecord,
  storeWorkspaceBackupRecord,
  WORKSPACE_BACKUP_TTL_MS,
  type WorkspaceBackupCandidateRequest,
} from './workspace-backup-cache.js';

const eligibleRequest = {
  fresh: true,
  devcontainer: false,
  setupCommands: ['  npm ci  ', ' npm run build\n'],
  setupEnvironment: {
    variables: { NODE_ENV: 'test', FEATURE_FLAG: 'enabled' },
    secretIdentities: { API_TOKEN: '{"version":1,"encryptedData":"ciphertext"}' },
  },
  userId: 'user-1',
  orgId: 'org-1',
  repository: { type: 'git' as const, url: 'https://token@example.com/acme/repo.git' },
  shallow: true,
};

const backup: DirectoryBackup = {
  id: 'backup-1',
  dir: '/workspace/repo',
  localBucket: true,
};

function bucketWith(value: unknown) {
  return {
    get: vi.fn(async () =>
      value === null
        ? null
        : {
            json: async () => value,
          }
    ),
    put: vi.fn(async () => undefined),
  };
}

describe('workspace backup cache policy', () => {
  it.each([[undefined], [[]]])(
    'rejects requests without setup commands: %j',
    async setupCommands => {
      await expect(
        buildWorkspaceBackupCandidate({ ...eligibleRequest, setupCommands })
      ).resolves.toBeNull();
    }
  );

  it.each([[['npm ci']], [['echo first', 'custom-tool --prepare', 'npm test']]])(
    'accepts fresh repository requests with setup commands: %j',
    async setupCommands => {
      await expect(
        buildWorkspaceBackupCandidate({ ...eligibleRequest, setupCommands })
      ).resolves.not.toBeNull();
    }
  );

  it('builds a credential-free opaque v1 organization candidate', async () => {
    const first = await buildWorkspaceBackupCandidate(eligibleRequest);
    const second = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      repository: { type: 'git', url: 'https://other-secret@example.com/acme/repo.git' },
    });

    expect(first).not.toBeNull();
    if (!first) return;
    expect(first).toEqual(second);
    expect(first.owner).toEqual({ type: 'organization', organizationId: 'org-1' });
    expect(first.canonicalRepository).toBe('https://example.com/acme/repo.git');
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.objectKey).toBe(`workspace-backups/v1/${first.digest}.json`);

    for (const value of ['user-1', 'org-1', 'repo', 'npm', 'NODE_ENV']) {
      expect(first.objectKey).not.toContain(value);
    }
  });

  it('shares organization candidates across users', async () => {
    const first = await buildWorkspaceBackupCandidate(eligibleRequest);
    const second = await buildWorkspaceBackupCandidate({ ...eligibleRequest, userId: 'user-2' });

    expect(first).toEqual(second);
  });

  it('isolates personal candidates by user', async () => {
    const first = await buildWorkspaceBackupCandidate({ ...eligibleRequest, orgId: undefined });
    const second = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      orgId: undefined,
      userId: 'user-2',
    });

    expect(first?.owner).toEqual({ type: 'user', userId: 'user-1' });
    expect(second?.owner).toEqual({ type: 'user', userId: 'user-2' });
    expect(first?.digest).not.toBe(second?.digest);
  });

  it('invalidates on repository, clone shape, setup commands, and setup environment', async () => {
    const base = await buildWorkspaceBackupCandidate(eligibleRequest);
    const variants = await Promise.all([
      buildWorkspaceBackupCandidate({ ...eligibleRequest, orgId: 'org-2' }),
      buildWorkspaceBackupCandidate({
        ...eligibleRequest,
        repository: { type: 'github', repo: 'acme/other' },
      }),
      buildWorkspaceBackupCandidate({ ...eligibleRequest, shallow: false }),
      buildWorkspaceBackupCandidate({ ...eligibleRequest, setupCommands: ['npm ci'] }),
      buildWorkspaceBackupCandidate({
        ...eligibleRequest,
        setupEnvironment: {
          ...eligibleRequest.setupEnvironment,
          variables: { ...eligibleRequest.setupEnvironment.variables, NODE_ENV: 'production' },
        },
      }),
    ]);

    expect(new Set([base?.digest, ...variants.map(value => value?.digest)]).size).toBe(6);
  });

  it('canonicalizes setup environment key order', async () => {
    const first = await buildWorkspaceBackupCandidate(eligibleRequest);
    const reordered = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      setupEnvironment: {
        variables: { FEATURE_FLAG: 'enabled', NODE_ENV: 'test' },
        secretIdentities: eligibleRequest.setupEnvironment.secretIdentities,
      },
    });

    expect(first?.digest).toBe(reordered?.digest);
  });

  it('invalidates on encrypted secret identity without using plaintext', async () => {
    const base = await buildWorkspaceBackupCandidate(eligibleRequest);
    const changedEnvelope = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      setupEnvironment: {
        ...eligibleRequest.setupEnvironment,
        secretIdentities: {
          API_TOKEN: '{"version":1,"encryptedData":"different-ciphertext"}',
        },
      },
    });

    expect(base?.digest).not.toBe(changedEnvelope?.digest);
  });

  it('preserves exact setup command bytes and order', async () => {
    const base = await buildWorkspaceBackupCandidate(eligibleRequest);
    const trimmed = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      setupCommands: ['npm ci', 'npm run build'],
    });
    const newlineChanged = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      setupCommands: ['  npm ci  ', ' npm run build\r\n'],
    });
    const reversed = await buildWorkspaceBackupCandidate({
      ...eligibleRequest,
      setupCommands: [...eligibleRequest.setupCommands].reverse(),
    });

    expect(base?.digest).not.toBe(trimmed?.digest);
    expect(base?.digest).not.toBe(newlineChanged?.digest);
    expect(base?.digest).not.toBe(reversed?.digest);
  });

  it.each<[string, Partial<WorkspaceBackupCandidateRequest>]>([
    ['resume', { fresh: false }],
    ['devcontainer', { devcontainer: true }],
    ['empty user', { userId: '' }],
    ['empty organization', { orgId: '' }],
    ['invalid repository', { repository: { type: 'git', url: 'not-a-url' } }],
    ['invalid GitHub repository', { repository: { type: 'github', repo: 'invalid' } }],
  ])('rejects %s requests', async (_label, override) => {
    await expect(
      buildWorkspaceBackupCandidate({ ...eligibleRequest, ...override })
    ).resolves.toBeNull();
  });

  it('creates a 24-hour v1 record retaining owner and localBucket and stores it as JSON', async () => {
    const candidate = await buildWorkspaceBackupCandidate(eligibleRequest);
    expect(candidate).not.toBeNull();
    if (!candidate) return;

    const now = Date.parse('2026-06-10T12:00:00.000Z');
    const record = createWorkspaceBackupRecord(candidate, backup, 'a'.repeat(40), now);
    const bucket = bucketWith(null);

    expect(record.schema).toBe('workspace-backup-v1');
    expect(record.owner).toEqual(candidate.owner);
    expect(record.createdAt).toBe(now);
    expect(record.expiresAt).toBe(now + WORKSPACE_BACKUP_TTL_MS);
    expect(record.backup.localBucket).toBe(true);

    await storeWorkspaceBackupRecord(bucket as unknown as R2Bucket, candidate, record);
    expect(bucket.put).toHaveBeenCalledWith(candidate.objectKey, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
    });
  });

  it('loads only valid, matching, unexpired v1 records with the exact owner', async () => {
    const candidate = await buildWorkspaceBackupCandidate(eligibleRequest);
    expect(candidate).not.toBeNull();
    if (!candidate) return;

    const now = Date.parse('2026-06-10T12:00:00.000Z');
    const record = createWorkspaceBackupRecord(candidate, backup, 'b'.repeat(40), now);

    await expect(
      loadWorkspaceBackupRecord(bucketWith(record) as unknown as R2Bucket, candidate, now + 1)
    ).resolves.toEqual(record);

    const invalidRecords = [
      { ...record, schema: 'workspace-backup-v2' },
      { ...record, expiresAt: now },
      { ...record, digest: '0'.repeat(64) },
      { ...record, owner: { type: 'organization', organizationId: 'other-org' } },
      { ...record, owner: { type: 'user', userId: 'org-1' } },
      { invalid: true },
    ];
    for (const invalidRecord of invalidRecords) {
      await expect(
        loadWorkspaceBackupRecord(bucketWith(invalidRecord) as unknown as R2Bucket, candidate, now)
      ).resolves.toBeNull();
    }
  });

  it('rejects storing a record whose owner does not exactly match the candidate', async () => {
    const candidate = await buildWorkspaceBackupCandidate(eligibleRequest);
    if (!candidate) throw new Error('expected eligible candidate');
    const record = createWorkspaceBackupRecord(candidate, backup, 'c'.repeat(40), 1);
    const bucket = bucketWith(null);

    await expect(
      storeWorkspaceBackupRecord(bucket as unknown as R2Bucket, candidate, {
        ...record,
        owner: { type: 'user', userId: 'org-1' },
      })
    ).rejects.toThrow('Workspace backup record does not match its cache candidate');
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('treats R2 lookup failures as cold misses', async () => {
    const candidate = await buildWorkspaceBackupCandidate(eligibleRequest);
    if (!candidate) throw new Error('expected eligible candidate');
    const bucket = { get: vi.fn().mockRejectedValue(new Error('R2 unavailable')) };

    await expect(
      loadWorkspaceBackupRecord(bucket as unknown as R2Bucket, candidate)
    ).resolves.toBeNull();
  });

  it.each([
    ['future creation', { createdAt: 101, expiresAt: 102 }],
    ['nonpositive lifetime', { createdAt: 100, expiresAt: 100 }],
    ['oversized lifetime', { createdAt: 1, expiresAt: 1 + WORKSPACE_BACKUP_TTL_MS + 1 }],
  ])('rejects records with %s', async (_label, timestamps) => {
    const candidate = await buildWorkspaceBackupCandidate(eligibleRequest);
    if (!candidate) throw new Error('expected eligible candidate');
    const record = createWorkspaceBackupRecord(candidate, backup, 'd'.repeat(40), 1);

    await expect(
      loadWorkspaceBackupRecord(
        bucketWith({ ...record, ...timestamps }) as unknown as R2Bucket,
        candidate,
        100
      )
    ).resolves.toBeNull();
  });
});
