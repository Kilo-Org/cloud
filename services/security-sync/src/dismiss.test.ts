import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processSecurityFindingDismissal } from './dismiss.js';
import type { SecurityDismissMessage } from './index.js';

const finding = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  source: 'dependabot',
  source_id: '42',
  repo_full_name: 'kilo/repo',
  status: 'open',
  owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owned_by_user_id: null,
};

function createDb(selectedFinding = finding, options: { failAuditInsert?: boolean } = {}) {
  const updates: unknown[] = [];
  const auditRows: unknown[] = [];
  function createOperations(targetUpdates: unknown[], targetAuditRows: unknown[]) {
    return {
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            targetUpdates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          if (options.failAuditInsert) {
            throw new Error('audit insert failed');
          }
          targetAuditRows.push(values);
        },
      }),
    };
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [selectedFinding],
        }),
      }),
    }),
    ...createOperations(updates, auditRows),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      const stagedUpdates: unknown[] = [];
      const stagedAuditRows: unknown[] = [];
      const result = await callback(createOperations(stagedUpdates, stagedAuditRows));
      updates.push(...stagedUpdates);
      auditRows.push(...stagedAuditRows);
      return result;
    },
  };

  return { db: db as never, updates, auditRows };
}

function createMessage(): SecurityDismissMessage {
  return {
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
  };
}

describe('processSecurityFindingDismissal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('updates local finding state and audit only after upstream Dependabot dismissal succeeds', async () => {
    const { db, updates, auditRows } = createDb();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken: async () => 'github-token' } as GitTokenService,
        message: createMessage(),
      })
    ).resolves.toEqual({ dismissed: true, findingSource: 'dependabot' });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'owner@example.com',
    });
    expect(auditRows[0]).toMatchObject({
      actor_id: 'user-123',
      action: 'security.finding.dismissed',
      resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      after_state: { status: 'ignored', ignoredReason: 'not_used' },
    });
  });

  it('preserves local state when upstream Dependabot dismissal fails transiently', async () => {
    const { db, updates, auditRows } = createDb();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken: async () => 'github-token' } as GitTokenService,
        message: createMessage(),
      })
    ).rejects.toThrow('GitHub Dependabot dismissal failed with 503');

    expect(updates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('rolls back the local finding update when audit insert fails', async () => {
    const { db, updates, auditRows } = createDb(finding, { failAuditInsert: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken: async () => 'github-token' } as GitTokenService,
        message: createMessage(),
      })
    ).rejects.toThrow('audit insert failed');

    expect(updates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('does not mutate local state when Dependabot source metadata is malformed', async () => {
    const { db, updates, auditRows } = createDb({ ...finding, source_id: '42junk' });
    const getToken = vi.fn().mockResolvedValue('github-token');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken } as unknown as GitTokenService,
        message: createMessage(),
      })
    ).resolves.toEqual({ dismissed: false, findingSource: 'dependabot' });

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('dismisses non-Dependabot findings locally without upstream writeback', async () => {
    const { db, updates, auditRows } = createDb({ ...finding, source: 'pnpm_audit' });
    const getToken = vi.fn().mockResolvedValue('github-token');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken } as unknown as GitTokenService,
        message: createMessage(),
      })
    ).resolves.toEqual({ dismissed: true, findingSource: 'pnpm_audit' });

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'owner@example.com',
    });
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.dismissed',
      metadata: { source: 'pnpm_audit' },
    });
  });

  it('leaves already ignored findings untouched', async () => {
    const { db, updates, auditRows } = createDb({ ...finding, status: 'ignored' });
    const getToken = vi.fn().mockResolvedValue('github-token');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken } as unknown as GitTokenService,
        message: createMessage(),
      })
    ).resolves.toEqual({ dismissed: false, findingSource: 'dependabot' });

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('ignores dismissal commands for findings owned by another tenant', async () => {
    const { db, updates, auditRows } = createDb({
      ...finding,
      owned_by_organization_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const getToken = vi.fn().mockResolvedValue('github-token');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      processSecurityFindingDismissal({
        db,
        gitTokenService: { getToken } as unknown as GitTokenService,
        message: createMessage(),
      })
    ).resolves.toEqual({ dismissed: false, findingSource: null });

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});
