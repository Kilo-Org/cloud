import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH } from '@kilocode/sts-contracts';
import { dispatchNotification, runSecurityNotificationSweep } from './sweep.js';

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

describe('dispatchNotification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('presents the credential header it is given and reads the endpoint outcome', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ outcome: 'sent' }));

    const outcome = await dispatchNotification(
      'https://app.test',
      { kind: 'ready', header: 'authorization', value: 'Bearer sts-token' },
      'notification-1'
    );

    expect(outcome).toEqual({ outcome: 'sent' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://app.test/api/internal/security-agent/notifications');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sts-token');
    expect(headers.has('X-Internal-Secret')).toBe(false);
  });
});

/**
 * A database with one due, eligible pending notification. `claim` counts the claims of the
 * dispatch phase (`status: 'sending'`), `update` the outcome writes after a dispatch (sent, or a
 * failure that spends an attempt).
 */
function createDispatchDb() {
  const claim = vi.fn();
  const update = vi.fn();
  const pendingRow = {
    notificationId: 'notification-1',
    findingId: '11111111-1111-4111-8111-111111111111',
    recipientUserId: 'user-1',
    kind: 'new_finding',
    status: 'pending',
    attemptCount: 0,
    ownedByOrganizationId: null,
    ownedByUserId: 'user-1',
    repoFullName: 'acme/api',
    findingStatus: 'open',
    severity: 'high',
    slaDueAt: null,
    ignoredReason: null,
  };
  let selectCount = 0;
  let limitCount = 0;

  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (values.status === 'sending') claim(values);
          else if (values.status === 'sent' || 'attempt_count' in values) update(values);
          return {
            returning: async () => (values.status === 'sending' ? [{ id: 'notification-1' }] : []),
          };
        },
      }),
    }),
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
                config: { new_finding_notifications_enabled: true },
              },
            ],
          }),
        };
      }
      return {
        from() {
          return this;
        },
        innerJoin() {
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        // No staged rows; the pending row is eligible, then due.
        limit: async () => (++limitCount === 1 ? [] : [pendingRow]),
      };
    },
    execute: async () => ({ rows: [] }),
  };

  return { db, claim, update };
}

describe('runSecurityNotificationSweep dispatch credential', () => {
  const dispatchEnv = {
    HYPERDRIVE: { connectionString: 'postgres://worker' },
    BACKEND_API_URL: 'https://app.test',
    SECURITY_NOTIFICATION_DISPATCH_ENABLED: 'true',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('reads the legacy secret once for the tick and dispatches with it', async () => {
    const { db, claim, update } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const secret = vi.fn(async () => 'internal-secret');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ outcome: 'sent' }));

    const result = await runSecurityNotificationSweep({
      ...dispatchEnv,
      INTERNAL_API_SECRET: { get: secret },
    });

    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(secret).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('X-Internal-Secret')).toBe('internal-secret');
    expect(headers.has('authorization')).toBe(false);
  });

  it('skips the dispatch phase, claiming nothing, when the legacy secret is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, claim, update } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await runSecurityNotificationSweep(dispatchEnv);

    expect(result).toMatchObject({ processed: 0, sent: 0, retried: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[security-notifications] BACKEND_API_URL or app credential missing; skipping dispatch'
    );
  });

  it('claims and updates nothing when the STS binding throws a retryable ServiceTokenError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, claim, update } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const secret = vi.fn(async () => 'internal-secret');
    const mintTokens = vi.fn(async () => {
      throw new ServiceTokenError(
        { reason: 'unavailable', retryAfterSeconds: 5 },
        STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH
      );
    });

    const result = await runSecurityNotificationSweep({
      ...dispatchEnv,
      INTERNAL_API_SECRET: { get: secret },
      WEB_INTERNAL_AUTH: 'sts',
      STS: { mintTokens },
    });

    expect(mintTokens).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 0, sent: 0, retried: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[security-notifications] BACKEND_API_URL or app credential missing; skipping dispatch'
    );
  });
});
