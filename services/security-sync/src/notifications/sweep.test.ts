import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { runSecurityNotificationSweep } from './sweep.js';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));

function createRecoveryOnlyDb() {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
    select: () => {
      throw new Error('select should not run when notification rollout flags are disabled');
    },
  };
}

function createStagedRecoveryDb(
  config: Record<string, unknown> = { new_finding_notifications_enabled: true }
) {
  const operations: string[] = [];
  let updateCount = 0;
  let selectCount = 0;
  let selectRowsCount = 0;
  let executeCount = 0;

  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updateCount++;
            if (updateCount === 1) {
              operations.push('recover-stuck-claims');
              return [];
            }
            operations.push(values.status === 'pending' ? 'publish-staged' : 'update');
            return [{ id: 'notification-1' }];
          },
        }),
      }),
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      const tx = {
        execute: async () => {
          operations.push('canonicalize');
          return {
            rows: [
              {
                findingId: '11111111-1111-4111-8111-111111111111',
                previousStatus: 'open',
                previousSeverity: 'high',
                effectiveStatus: 'ignored',
                effectiveSeverity: 'high',
                findingCreatedAt: '2026-06-01T10:00:00.000Z',
                ownedByUserId: 'user-1',
                ownedByOrganizationId: null,
                source: 'dependabot',
                sourceId: '42',
                repoFullName: 'acme/api',
                title: 'Prototype Pollution in lodash',
                packageName: 'lodash',
                packageEcosystem: 'npm',
                manifestPath: 'package.json',
                patchedVersion: '4.17.21',
                ghsaId: 'GHSA-xxxx-yyyy-zzzz',
                cveId: null,
                cweIds: null,
                cvssScore: null,
                dependabotHtmlUrl: null,
                firstDetectedAt: '2026-06-01T10:00:00.000Z',
                fixedAt: null,
                slaDueAt: '2026-06-08T10:00:00.000Z',
                canonicalFindingId: '22222222-2222-4222-8222-222222222222',
              },
            ],
          };
        },
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            operations.push(`insert-audit:${String(values.action)}`);
            return {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: 'audit-1' }],
              }),
            };
          },
        }),
      };
      return callback(tx);
    },
    select: () => {
      selectCount++;
      if (selectCount === 1) {
        return {
          from: () => ({
            where: async () => [
              {
                ownedByOrganizationId: null,
                ownedByUserId: 'user-1',
                isEnabled: true,
                config,
              },
            ],
          }),
        };
      }

      return {
        from: () => ({
          innerJoin() {
            return this;
          },
          where() {
            return this;
          },
          orderBy() {
            return this;
          },
          limit: async () => {
            selectRowsCount++;
            if (selectRowsCount === 1) {
              return [
                {
                  notificationId: 'notification-1',
                  findingId: '11111111-1111-4111-8111-111111111111',
                  recipientUserId: 'user-1',
                  kind: 'new_finding',
                  status: 'staged',
                  attemptCount: 0,
                  ownedByOrganizationId: null,
                  ownedByUserId: 'user-1',
                  repoFullName: 'acme/api',
                  findingStatus: 'open',
                  severity: 'high',
                  slaDueAt: null,
                  ignoredReason: null,
                },
              ];
            }
            return [];
          },
        }),
      };
    },
    execute: async () => {
      executeCount++;
      operations.push(`load-backlog-observability:${executeCount}`);
      return { rows: [] };
    },
  };

  return { db, operations };
}

describe('runSecurityNotificationSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('skips without Hyperdrive binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runSecurityNotificationSweep({});

    expect(result).toMatchObject({
      recovered: 0,
      stagedRecovered: 0,
      cancelled: 0,
      materialized: 0,
      processed: 0,
    });
    expect(getWorkerDb).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[security-notifications] HYPERDRIVE not bound; skipping');
  });

  it('treats malformed rollout flags as disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.mocked(getWorkerDb).mockReturnValue(createRecoveryOnlyDb() as never);

    const result = await runSecurityNotificationSweep({
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED: 'TRUE',
      SECURITY_NOTIFICATION_DISPATCH_ENABLED: 'yes',
    });

    expect(result).toMatchObject({
      recovered: 0,
      stagedRecovered: 0,
      cancelled: 0,
      materialized: 0,
      processed: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      '[security-notifications] malformed rollout flag; treating as disabled',
      { name: 'SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED' }
    );
    expect(warn).toHaveBeenCalledWith(
      '[security-notifications] malformed rollout flag; treating as disabled',
      { name: 'SECURITY_NOTIFICATION_DISPATCH_ENABLED' }
    );
  });

  it('cancels staged New-finding Notifications when they are disabled by default', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, operations } = createStagedRecoveryDb({});
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await runSecurityNotificationSweep({
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SECURITY_NOTIFICATION_DISPATCH_ENABLED: 'true',
    });

    expect(result).toMatchObject({ stagedRecovered: 0, cancelled: 1 });
    expect(operations.slice(0, 4)).toEqual([
      'recover-stuck-claims',
      'canonicalize',
      'insert-audit:security.finding.superseded',
      'update',
    ]);
  });

  it('canonicalizes owner-scoped duplicate findings before publishing staged notifications', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, operations } = createStagedRecoveryDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await runSecurityNotificationSweep({
      HYPERDRIVE: { connectionString: 'postgres://worker' },
      SECURITY_NOTIFICATION_DISPATCH_ENABLED: 'true',
    });

    expect(result).toMatchObject({ stagedRecovered: 1, cancelled: 0 });
    expect(operations.slice(0, 4)).toEqual([
      'recover-stuck-claims',
      'canonicalize',
      'insert-audit:security.finding.superseded',
      'publish-staged',
    ]);
  });
});
