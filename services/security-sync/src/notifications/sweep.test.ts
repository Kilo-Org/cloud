import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { getWorkerDb } from '@kilocode/db/client';
import { runSecurityNotificationSweep } from './sweep.js';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ waitUntil: vi.fn() }));

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

// Synthetic fixture values only. Each source holds a different value, so a dispatch that read the
// wrong source, or fell back to it, sends a header the test refuses.
const STORE_SECRET = 'store-internal-fixture-0123456789abcdef';
const BUNDLE_SECRET = 'bundle-internal-fixture-0123456789abcdef';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>): BundleResult {
  return {
    status: 'ok',
    workload: 'cloudflare-security-sync',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing: [],
  };
}

/**
 * One enabled user owner with one due, eligible New-finding Notification. Records each update so a
 * test can see whether dispatch claimed the row.
 */
function createDispatchDb() {
  const operations: string[] = [];
  let updateCount = 0;
  let rowSelectCount = 0;
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
    severity: 'critical',
    slaDueAt: null,
    ignoredReason: null,
  };
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
            operations.push(`update:${String(values.status)}`);
            return [{ id: 'notification-1' }];
          },
          then: (resolve: (value: unknown) => void) => {
            operations.push(`update:${String(values.status)}`);
            resolve(undefined);
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        // loadOwnerConfigStates awaits `where` directly.
        where() {
          return Object.assign(
            Promise.resolve([
              {
                ownedByOrganizationId: null,
                ownedByUserId: 'user-1',
                isEnabled: true,
                config: { new_finding_notifications_enabled: true },
              },
            ]),
            { orderBy: () => ({ limit: async () => rows() }) }
          );
        },
        innerJoin() {
          return this;
        },
      }),
    }),
    execute: async () => ({ rows: [] }),
  };
  // Staged recovery, then pending cancellation, then the due-row selection that dispatch reads.
  function rows() {
    rowSelectCount++;
    return rowSelectCount === 3 ? [pendingRow] : [];
  }
  return { db, operations };
}

function dispatchEnv(source: string | undefined, getBundle?: BundleBinding['getBundle']) {
  const storeGet = vi.fn(async () => STORE_SECRET);
  const env = {
    ...(source === undefined ? {} : { SECRETS_SOURCE: source }),
    HYPERDRIVE: { connectionString: 'postgres://worker' },
    BACKEND_API_URL: 'https://web.test',
    SECURITY_NOTIFICATION_DISPATCH_ENABLED: 'true',
    INTERNAL_API_SECRET: { get: storeGet },
    ...(getBundle === undefined ? {} : { STS: { getBundle } satisfies BundleBinding }),
  };
  return { env, storeGet };
}

describe('runSecurityNotificationSweep secrets source', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(Response.json({ outcome: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentHeader(): string | null {
    const init = fetchMock.mock.calls[0]?.[1];
    return new Headers(init?.headers).get('X-Internal-Secret');
  }

  it.each([undefined, 'secrets-store'])(
    'dispatches with the Secrets Store value and reads no bundle (SECRETS_SOURCE %j)',
    async source => {
      const { db, operations } = createDispatchDb();
      vi.mocked(getWorkerDb).mockReturnValue(db as never);
      const getBundle = vi.fn<BundleBinding['getBundle']>(async () =>
        okBundle({ INTERNAL_API_SECRET: BUNDLE_SECRET })
      );
      const { env, storeGet } = dispatchEnv(source, getBundle);

      const result = await runSecurityNotificationSweep(env);

      expect(result).toMatchObject({ processed: 1, sent: 1 });
      expect(sentHeader()).toBe(STORE_SECRET);
      expect(storeGet).toHaveBeenCalledOnce();
      expect(getBundle).not.toHaveBeenCalled();
      expect(operations).toEqual(['recover-stuck-claims', 'update:sending', 'update:sent']);
    }
  );

  it('dispatches with the bundle value under sts and never reads the Secrets Store', async () => {
    const { db } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const getBundle = vi.fn<BundleBinding['getBundle']>(async () =>
      okBundle({ INTERNAL_API_SECRET: BUNDLE_SECRET })
    );
    const { env, storeGet } = dispatchEnv('sts', getBundle);

    const result = await runSecurityNotificationSweep(env);

    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(sentHeader()).toBe(BUNDLE_SECRET);
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeGet).not.toHaveBeenCalled();
  });

  it('skips dispatch under sts when the bundle cannot serve the name, with no fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, operations } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const getBundle = vi.fn<BundleBinding['getBundle']>(async () => okBundle({}));
    const { env, storeGet } = dispatchEnv('sts', getBundle);

    const result = await runSecurityNotificationSweep(env);

    expect(result).toMatchObject({ processed: 0, sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeGet).not.toHaveBeenCalled();
    expect(operations).toEqual(['recover-stuck-claims']);
    expect(warn).toHaveBeenCalledWith('[security-notifications] STS internal secret read failed', {
      reason: 'not_granted',
    });
    expect(warn).toHaveBeenCalledWith(
      '[security-notifications] BACKEND_API_URL or internal secret missing; skipping dispatch'
    );
  });

  it('skips dispatch under sts without the STS binding, with no fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const { env, storeGet } = dispatchEnv('sts');

    const result = await runSecurityNotificationSweep(env);

    expect(result).toMatchObject({ processed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeGet).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[security-notifications] STS internal secret read failed', {
      reason: 'binding_missing',
    });
  });

  it('skips dispatch and reads neither source on a malformed SECRETS_SOURCE', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = createDispatchDb();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const getBundle = vi.fn<BundleBinding['getBundle']>();
    const { env, storeGet } = dispatchEnv('STS', getBundle);

    const result = await runSecurityNotificationSweep(env);

    expect(result).toMatchObject({ processed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeGet).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[security-notifications] SECRETS_SOURCE is malformed; skipping dispatch read'
    );
  });

  it('reads no secret under sts when dispatch is disabled', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(createRecoveryOnlyDb() as never);
    const getBundle = vi.fn<BundleBinding['getBundle']>();
    const { env, storeGet } = dispatchEnv('sts', getBundle);

    await runSecurityNotificationSweep({ ...env, SECURITY_NOTIFICATION_DISPATCH_ENABLED: 'false' });

    expect(getBundle).not.toHaveBeenCalled();
    expect(storeGet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
