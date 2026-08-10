import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { dispatchUserDataExport } from '@/lib/user-data-export-worker-client';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  user_data_export_outbox,
  user_data_export_object_deletions,
  user_data_export_parts,
  user_data_exports,
  type User,
} from '@kilocode/db/schema';

jest.mock('@/lib/user-data-export-worker-client', () => ({
  dispatchUserDataExport: jest.fn(),
}));

const mockDispatchUserDataExport = jest.mocked(dispatchUserDataExport);

describe('adminUserDataExportsRouter', () => {
  let admin: User;
  let regularUser: User;
  let owner: User;
  let leaseLessOwner: User;
  let recoveryOwner: User;
  let exportIds: string[] = [];
  let deletionKeys: string[] = [];

  beforeAll(async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    admin = await insertTestUser({
      google_user_email: `data-export-health-admin-${suffix}@example.com`,
      is_admin: true,
    });
    regularUser = await insertTestUser({
      google_user_email: `data-export-health-regular-${suffix}@example.com`,
    });
    owner = await insertTestUser({
      google_user_email: `data-export-health-owner-${suffix}@example.com`,
      google_user_name: 'Export Owner',
    });
    leaseLessOwner = await insertTestUser({
      google_user_email: `data-export-lease-less-owner-${suffix}@example.com`,
    });
    recoveryOwner = await insertTestUser({
      google_user_email: `data-export-recovery-owner-${suffix}@example.com`,
      google_user_name: 'Recovery Owner',
    });
  });

  beforeEach(async () => {
    mockDispatchUserDataExport.mockResolvedValue({ kind: 'accepted' });
    const now = Date.now();
    const rows = await db
      .insert(user_data_exports)
      .values([
        {
          kilo_user_id: owner.id,
          status: 'failed',
          snapshot_at: new Date(now - 86_400_000).toISOString(),
          multipart_upload_id: 'multipart-failed',
          failure_code: 'queue_delivery_exhausted',
          last_error_redacted: 'The export could not be completed after multiple attempts.',
          requested_at: new Date(now - 3_600_000).toISOString(),
        },
        {
          kilo_user_id: leaseLessOwner.id,
          status: 'processing',
          snapshot_at: new Date(now - 86_400_000).toISOString(),
          current_source: 'kilocode_users',
          multipart_upload_id: 'multipart-processing',
          next_part_number: 2,
          dispatch_generation: 1,
          lease_token: crypto.randomUUID(),
          lease_expires_at: new Date(now - 60_000).toISOString(),
          attempt_count: 2,
          row_count: 17,
          requested_at: new Date(now - 1_800_000).toISOString(),
          started_at: new Date(now - 1_700_000).toISOString(),
        },
        {
          kilo_user_id: owner.id,
          status: 'ready',
          snapshot_at: new Date(now - 86_400_000).toISOString(),
          r2_object_key: `exports/${crypto.randomUUID()}/kilo-data-export.jsonl.gz`,
          size_bytes: 2048,
          completed_at: new Date(now - 1_200_000).toISOString(),
          expires_at: new Date(now + 86_400_000).toISOString(),
          email_status: 'sending',
          email_attempt_count: 2,
          email_lease_token: crypto.randomUUID(),
          email_lease_expires_at: new Date(now - 60_000).toISOString(),
          requested_at: new Date(now - 1_500_000).toISOString(),
        },
        {
          kilo_user_id: owner.id,
          status: 'processing',
          snapshot_at: new Date(now - 86_400_000).toISOString(),
          dispatch_generation: 0,
          lease_token: null,
          lease_expires_at: null,
          requested_at: new Date(now - 900_000).toISOString(),
          started_at: new Date(now - 850_000).toISOString(),
        },
      ])
      .returning({ id: user_data_exports.id, status: user_data_exports.status });
    exportIds = rows.map(row => row.id);
    const processing = rows.find(row => row.status === 'processing');
    const failed = rows.find(row => row.status === 'failed');
    const processingWithoutLease = rows.find(
      row => row.status === 'processing' && row.id !== processing?.id
    );
    if (!processing || !failed || !processingWithoutLease)
      throw new Error('Expected export fixtures');
    await db.insert(user_data_export_outbox).values([
      {
        export_id: processing.id,
        generation: 1,
        available_at: new Date(now - 120_000).toISOString(),
        attempt_count: 1,
      },
      {
        export_id: failed.id,
        generation: 0,
        sent_at: new Date(now - 3_500_000).toISOString(),
      },
      {
        export_id: processingWithoutLease.id,
        generation: 0,
        sent_at: new Date(now - 800_000).toISOString(),
      },
    ]);
    await db.insert(user_data_export_parts).values({
      export_id: processing.id,
      part_number: 1,
      etag: 'safe-etag',
      size_bytes: 1024,
    });
  });

  afterEach(async () => {
    if (exportIds.length > 0)
      await db.delete(user_data_exports).where(inArray(user_data_exports.id, exportIds));
    exportIds = [];
    if (deletionKeys.length > 0)
      await db
        .delete(user_data_export_object_deletions)
        .where(inArray(user_data_export_object_deletions.object_key, deletionKeys));
    deletionKeys = [];
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await db
      .delete(kilocode_users)
      .where(
        inArray(kilocode_users.id, [
          admin.id,
          regularUser.id,
          owner.id,
          leaseLessOwner.id,
          recoveryOwner.id,
        ])
      );
  });

  it('requires admin access', async () => {
    const caller = await createCallerForUser(regularUser.id);

    await expect(caller.admin.userDataExports.summary()).rejects.toThrow('Admin access required');
    await expect(caller.admin.userDataExports.list({})).rejects.toThrow('Admin access required');
    await expect(caller.admin.userDataExports.detail({ exportId: exportIds[0]! })).rejects.toThrow(
      'Admin access required'
    );
    for (const mutation of [
      () =>
        caller.admin.userDataExports.redispatch({ exportId: exportIds[0]!, expectedGeneration: 0 }),
      () =>
        caller.admin.userDataExports.cancelAndPurge({
          exportId: exportIds[0]!,
          expectedGeneration: 0,
        }),
      () =>
        caller.admin.userDataExports.cancelAndRetry({
          exportId: exportIds[0]!,
          expectedGeneration: 0,
        }),
    ]) {
      await expect(mutation()).rejects.toThrow('Admin access required');
    }
  });

  it('summarizes persisted failure, lease, dispatch, cleanup, and email health', async () => {
    const result = await (await createCallerForUser(admin.id)).admin.userDataExports.summary();

    expect(result).toMatchObject({
      active: 2,
      needsAttention: 4,
      staleLeases: 1,
      pendingDispatches: 1,
      failed: 1,
      cleanupDue: 1,
      emailUnhealthy: 1,
    });
    expect(result.asOf).toMatch(/Z$/);
    expect(result.oldestPendingAt).toMatch(/Z$/);
  });

  it('lists needs-attention exports and supports exact owner email search', async () => {
    const caller = await createCallerForUser(admin.id);
    const all = await caller.admin.userDataExports.list({ health: 'needs_attention' });
    const searched = await caller.admin.userDataExports.list({
      health: 'all',
      search: owner.google_user_email,
    });

    expect(all.pagination.total).toBe(4);
    expect(all.rows).toHaveLength(4);
    expect(all.rows.map(row => row.health.severity)).toEqual(
      expect.arrayContaining(['error', 'degraded'])
    );
    expect(searched.pagination.total).toBe(3);
    expect(searched.rows.every(row => row.user.id === owner.id)).toBe(true);
    expect(searched.rows.every(row => row.requestedAt.endsWith('Z'))).toBe(true);
    expect(searched.rows.find(row => row.status === 'ready')?.health).toMatchObject({
      severity: 'degraded',
      email: 'retry_due',
      reasons: expect.arrayContaining(['email_retry_due']),
    });
    expect(
      all.rows.find(row => row.status === 'processing' && row.health.execution === 'inconsistent')
        ?.health
    ).toMatchObject({
      severity: 'error',
      dispatch: 'published',
      reasons: expect.arrayContaining(['processing_without_lease']),
    });
  });

  it('normalizes out-of-range pages to the first page', async () => {
    const result = await (
      await createCallerForUser(admin.id)
    ).admin.userDataExports.list({
      health: 'all',
      page: 10_000,
      limit: 2,
    });

    expect(result.pagination).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(result.rows).toHaveLength(2);
  });

  it('returns legacy part aggregates, outbox history, and redacted failure details', async () => {
    const caller = await createCallerForUser(admin.id);
    const processing = await db.query.user_data_exports.findFirst({
      where: eq(user_data_exports.status, 'processing'),
      columns: { id: true },
    });
    const failed = await db.query.user_data_exports.findFirst({
      where: eq(user_data_exports.status, 'failed'),
      columns: { id: true },
    });
    if (!processing || !failed) throw new Error('Expected export fixtures');

    const processingDetail = await caller.admin.userDataExports.detail({
      exportId: processing.id,
    });
    const failedDetail = await caller.admin.userDataExports.detail({ exportId: failed.id });

    expect(processingDetail.parts).toEqual({
      count: 1,
      checkpointSizeBytes: 1024,
      firstPartNumber: 1,
      lastPartNumber: 1,
    });
    expect(processingDetail.outbox.items[0]).toMatchObject({
      generation: 1,
      attemptCount: 1,
      isCurrentGeneration: true,
    });
    expect(processingDetail.health.execution).toBe('lease_recovery_due');
    expect(processingDetail.health.reasons).toContain('retired_generator_state');
    expect(failedDetail.failureCode).toBe('queue_delivery_exhausted');
    expect(failedDetail.failureMessage).toBe(
      'The export could not be completed after multiple attempts.'
    );
    expect(JSON.stringify(failedDetail)).not.toContain('multipart-failed');
    expect(JSON.stringify(processingDetail)).not.toContain('safe-etag');
  });

  it('returns not found for an unknown export', async () => {
    await expect(
      (await createCallerForUser(admin.id)).admin.userDataExports.detail({
        exportId: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('redispatches an active export as a clean one-shot run with a fenced generation', async () => {
    expect(admin.is_super_admin).toBe(false);
    const requestedAt = new Date(Date.now() - 3_600_000).toISOString();
    const [target] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: recoveryOwner.id,
        status: 'processing',
        snapshot_at: '2026-08-03T00:00:00.000Z',
        requested_at: requestedAt,
        current_source: 'kilocode_users',
        multipart_upload_id: 'recovery-upload',
        next_part_number: 2,
        dispatch_generation: 3,
        lease_token: crypto.randomUUID(),
        lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
        attempt_count: 2,
        row_count: 42,
      })
      .returning({ id: user_data_exports.id });
    exportIds.push(target.id);
    await db.insert(user_data_export_parts).values({
      export_id: target.id,
      part_number: 1,
      etag: 'checkpoint-etag',
      size_bytes: 512,
    });
    await db.insert(user_data_export_outbox).values({
      export_id: target.id,
      generation: 3,
      attempt_count: 2,
      sent_at: null,
    });

    const result = await (
      await createCallerForUser(admin.id)
    ).admin.userDataExports.redispatch({
      exportId: target.id,
      expectedGeneration: 3,
    });

    expect(result).toMatchObject({ exportId: target.id, generation: 4, dispatch: 'sent' });
    const updated = await db.query.user_data_exports.findFirst({
      where: eq(user_data_exports.id, target.id),
    });
    expect(updated).toMatchObject({
      status: 'queued',
      current_source: null,
      multipart_upload_id: 'recovery-upload',
      next_part_number: 1,
      dispatch_generation: 4,
      lease_token: null,
      lease_expires_at: null,
      attempt_count: 0,
      row_count: 0,
    });
    expect(
      await db.query.user_data_export_parts.findMany({
        where: eq(user_data_export_parts.export_id, target.id),
      })
    ).toHaveLength(0);
    const outbox = await db.query.user_data_export_outbox.findMany({
      where: eq(user_data_export_outbox.export_id, target.id),
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ generation: 4, sent_at: null });
    expect(mockDispatchUserDataExport).toHaveBeenCalledWith({
      exportId: target.id,
      generation: 4,
      kiloUserId: recoveryOwner.id,
    });
  });

  it('rejects recovery when the expected generation is stale', async () => {
    const target = await db.query.user_data_exports.findFirst({
      where: (exports, { and, eq }) =>
        and(eq(exports.kilo_user_id, owner.id), eq(exports.status, 'failed')),
      columns: { id: true },
    });
    if (!target) throw new Error('Expected export fixture');

    await expect(
      (await createCallerForUser(admin.id)).admin.userDataExports.cancelAndPurge({
        exportId: target.id,
        expectedGeneration: 99,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await db.query.user_data_exports.findFirst({ where: eq(user_data_exports.id, target.id) })
    ).toBeDefined();
  });

  it('cancels an export, cascades checkpoint state, and persists cleanup work', async () => {
    const [target] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: recoveryOwner.id,
        status: 'processing',
        snapshot_at: '2026-08-03T00:00:00.000Z',
        multipart_upload_id: 'purge-upload',
        dispatch_generation: 2,
        lease_token: crypto.randomUUID(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning({ id: user_data_exports.id });
    exportIds.push(target.id);
    const key = `exports/${target.id}/kilo-data-export.jsonl.gz`;
    deletionKeys.push(key);
    await db.insert(user_data_export_parts).values({
      export_id: target.id,
      part_number: 1,
      etag: 'purge-etag',
      size_bytes: 256,
    });
    await db.insert(user_data_export_outbox).values({ export_id: target.id, generation: 2 });

    await expect(
      (await createCallerForUser(admin.id)).admin.userDataExports.cancelAndPurge({
        exportId: target.id,
        expectedGeneration: 2,
      })
    ).resolves.toMatchObject({ exportId: target.id, cleanup: 'queued' });

    expect(
      await db.query.user_data_exports.findFirst({ where: eq(user_data_exports.id, target.id) })
    ).toBeUndefined();
    expect(
      await db.query.user_data_export_parts.findMany({
        where: eq(user_data_export_parts.export_id, target.id),
      })
    ).toHaveLength(0);
    expect(
      await db.query.user_data_export_outbox.findMany({
        where: eq(user_data_export_outbox.export_id, target.id),
      })
    ).toHaveLength(0);
    expect(
      await db.query.user_data_export_object_deletions.findFirst({
        where: eq(user_data_export_object_deletions.object_key, key),
      })
    ).toMatchObject({
      object_key: key,
      multipart_upload_id: 'purge-upload',
      reason: 'admin_cancel',
    });
  });

  it('creates a pristine replacement from the same logical snapshot and durable outbox', async () => {
    const requestedAt = new Date(Date.now() - 7_200_000).toISOString();
    const [target] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: recoveryOwner.id,
        status: 'failed',
        schema_version: 1,
        snapshot_at: '2026-08-03T00:00:00.000Z',
        requested_at: requestedAt,
        multipart_upload_id: 'replace-upload',
        dispatch_generation: 5,
        current_source: 'kilocode_users',
        next_part_number: 4,
        attempt_count: 5,
        row_count: 123,
        failure_code: 'queue_delivery_exhausted',
      })
      .returning({ id: user_data_exports.id });
    exportIds.push(target.id);
    const key = `exports/${target.id}/kilo-data-export.jsonl.gz`;
    deletionKeys.push(key);
    mockDispatchUserDataExport.mockResolvedValueOnce({
      kind: 'unavailable',
      reason: 'not_configured',
    });

    const result = await (
      await createCallerForUser(admin.id)
    ).admin.userDataExports.cancelAndRetry({
      exportId: target.id,
      expectedGeneration: 5,
    });
    exportIds.push(result.replacementExportId);

    expect(result).toMatchObject({ generation: 0, dispatch: 'pending', cleanup: 'queued' });
    expect(result.replacementExportId).not.toBe(target.id);
    expect(
      await db.query.user_data_exports.findFirst({ where: eq(user_data_exports.id, target.id) })
    ).toBeUndefined();
    const replacement = await db.query.user_data_exports.findFirst({
      where: eq(user_data_exports.id, result.replacementExportId),
    });
    if (!replacement) throw new Error('Expected replacement export');
    expect(replacement).toMatchObject({
      kilo_user_id: recoveryOwner.id,
      status: 'queued',
      schema_version: 1,
      snapshot_at: expect.any(String),
      requested_at: expect.any(String),
      current_source: null,
      multipart_upload_id: null,
      next_part_number: 1,
      dispatch_generation: 0,
      attempt_count: 0,
      row_count: 0,
      failure_code: null,
      email_status: 'pending',
    });
    expect(new Date(replacement.snapshot_at).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(new Date(replacement.requested_at).toISOString()).toBe(
      new Date(requestedAt).toISOString()
    );
    expect(
      await db.query.user_data_export_outbox.findFirst({
        where: eq(user_data_export_outbox.export_id, result.replacementExportId),
      })
    ).toMatchObject({ generation: 0, sent_at: null });
    expect(
      await db.query.user_data_export_object_deletions.findFirst({
        where: eq(user_data_export_object_deletions.object_key, key),
      })
    ).toMatchObject({ reason: 'admin_replace', multipart_upload_id: 'replace-upload' });
  });

  it('rejects replacement when another usable export exists for the owner', async () => {
    const [target] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: recoveryOwner.id,
        status: 'failed',
        snapshot_at: '2026-08-03T00:00:00.000Z',
      })
      .returning({ id: user_data_exports.id });
    const [blocker] = await db
      .insert(user_data_exports)
      .values({
        kilo_user_id: recoveryOwner.id,
        status: 'ready',
        snapshot_at: '2026-08-03T00:00:00.000Z',
        r2_object_key: `exports/${crypto.randomUUID()}/kilo-data-export.jsonl.gz`,
        size_bytes: 1024,
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .returning({ id: user_data_exports.id });
    exportIds.push(target.id, blocker.id);

    await expect(
      (await createCallerForUser(admin.id)).admin.userDataExports.cancelAndRetry({
        exportId: target.id,
        expectedGeneration: 0,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await db.query.user_data_exports.findFirst({ where: eq(user_data_exports.id, target.id) })
    ).toBeDefined();
    expect(mockDispatchUserDataExport).not.toHaveBeenCalled();
  });
});
