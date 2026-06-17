import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processSecurityFindingDismissal } from './dismiss.js';
import type { SecurityDismissMessage } from './index.js';

const finding = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  source: 'dependabot',
  source_id: '42',
  repo_full_name: 'kilo/repo',
  title: 'lodash vulnerable to prototype pollution',
  severity: 'high',
  status: 'open',
  package_name: 'lodash',
  package_ecosystem: 'npm',
  manifest_path: 'package.json',
  patched_version: '4.17.21',
  ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
  cve_id: 'CVE-2026-1234',
  cwe_ids: ['CWE-1321'],
  cvss_score: '7.5',
  dependabot_html_url: 'https://github.com/kilo/repo/security/dependabot/42',
  first_detected_at: '2026-05-17 08:30:00.000+00',
  fixed_at: null,
  sla_due_at: '2026-05-24 08:30:00.000+00',
  session_id: null,
  owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owned_by_user_id: null,
};

function createDb(
  selectedFinding = finding,
  options: {
    failAuditInsert?: boolean;
    actor?: { id: string; email: string; name: string; isAdmin: boolean };
  } = {}
) {
  const updates: unknown[] = [];
  const auditRows: unknown[] = [];
  let selectCount = 0;
  const actor = options.actor ?? {
    id: 'user-123',
    email: 'owner@example.com',
    name: 'Owner Example',
    isAdmin: false,
  };
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
        values: (values: unknown) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (options.failAuditInsert) {
                throw new Error('audit insert failed');
              }
              targetAuditRows.push(values);
              return [{ id: 'audit-row-1' }];
            },
          }),
        }),
      }),
    };
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [selectCount++ === 0 ? selectedFinding : actor],
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
    ).resolves.toEqual({
      dismissed: true,
      findingSource: 'dependabot',
      commandStatus: 'succeeded',
      resultCode: 'FINDING_DISMISSED',
    });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'owner@example.com',
    });
    expect(auditRows[0]).toMatchObject({
      actor_id: 'user-123',
      actor_type: 'customer_user',
      action: 'security.finding.dismissed',
      resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      event_key:
        'security_finding_audit:v1:organization%3Aaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:security.finding.dismissed:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      schema_version: 1,
      source_context: 'security_sync',
      after_state: { status: 'ignored', reason_code: 'not_used' },
      metadata: {
        source: 'dependabot',
        reason_code: 'not_used',
        source_writeback_outcome: 'dismissed',
      },
      finding_snapshot: {
        status: 'ignored',
        first_detected_at: '2026-05-17T08:30:00.000Z',
      },
    });
  });

  it('classifies the actor from authoritative user state at event-write time', async () => {
    const { db, auditRows } = createDb(finding, {
      actor: {
        id: 'user-123',
        email: 'customer-domain@example.com',
        name: 'Kilo Operator',
        isAdmin: true,
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await processSecurityFindingDismissal({
      db,
      gitTokenService: { getToken: async () => 'github-token' } as GitTokenService,
      message: createMessage(),
    });

    expect(auditRows[0]).toMatchObject({
      actor_id: 'user-123',
      actor_email: 'customer-domain@example.com',
      actor_type: 'kilo_admin',
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
    ).resolves.toEqual({
      dismissed: false,
      findingSource: 'dependabot',
      commandStatus: 'failed',
      resultCode: 'INVALID_DISMISS_TARGET',
    });

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
    ).resolves.toEqual({
      dismissed: true,
      findingSource: 'pnpm_audit',
      commandStatus: 'succeeded',
      resultCode: 'FINDING_DISMISSED',
    });

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
    ).resolves.toEqual({
      dismissed: false,
      findingSource: 'dependabot',
      commandStatus: 'no_op',
      resultCode: 'ALREADY_IGNORED',
    });

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
    ).resolves.toEqual({
      dismissed: false,
      findingSource: null,
      commandStatus: 'failed',
      resultCode: 'FINDING_UNAVAILABLE',
    });

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});
